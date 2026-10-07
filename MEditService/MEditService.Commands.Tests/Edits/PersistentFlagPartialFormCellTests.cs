using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class PersistentFlagPartialFormCellTests : TestInstance
{
    private const int Persistent = 0x0400, PartialForm = 0x4000;
    private const string OverrideOrigin = "OverrideMod";

    private readonly PluginAddress _override;
    private readonly FormKey _cell, _temporary, _persistent;

    public PersistentFlagPartialFormCellTests()
    {
        var master = new Fallout4Mod(ModKey.FromFileName("Master.esm"), Fallout4Release.Fallout4);
        var masterCell = new Cell(master) { EditorID = "Inside", Flags = Cell.Flag.IsInteriorCell };
        master.Cells.Records.Add(CellBlocks.Interior(masterCell));
        Add(master, "MasterMod", tracked: false);

        var copy = new Fallout4Mod(ModKey.FromFileName("Override.esp"), Fallout4Release.Fallout4);
        copy.ModHeader.MasterReferences.Add(new MasterReference { Master = master.ModKey });
        var partialCell = new Cell(masterCell.FormKey, Fallout4Release.Fallout4) { EditorID = "Inside", MajorRecordFlagsRaw = PartialForm };
        var temporary = new PlacedObject(copy) { EditorID = "PartialTemp" };
        var persistent = new PlacedObject(copy) { EditorID = "PartialPersist", MajorRecordFlagsRaw = Persistent };
        partialCell.Temporary.Add(temporary);
        partialCell.Persistent.Add(persistent);
        copy.Cells.Records.Add(CellBlocks.Interior(partialCell));
        _override = Add(copy, OverrideOrigin);
        (_cell, _temporary, _persistent) = (masterCell.FormKey, temporary.FormKey, persistent.FormKey);
    }

    private RecordEditResult SetFlags(FormKey placed, int raw) =>
        EditHandler.Edit(
            _override, placed.ToString(),
            SetAt(JsonDocument.Parse(raw.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));

    private List<string> Group(string group)
    {
        var cell = JsonNode.Parse(
            TrackedTree.Document(ModFolderOf(_override), _override, _cell.ToString()).Require().Body).Require();
        return [.. (cell[group] as JsonArray ?? []).Select(placed => placed.Require()["EditorID"].Require().GetValue<string>())];
    }

    [Fact]
    public void SettingPersistent_InAPartialFormCopyOfAnInteriorCell_MovesTheRecordIntoItsPersistentGroup()
    {
        var result = SetFlags(_temporary, Persistent);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["PartialPersist", "PartialTemp"], Group("Persistent"));
    }

    [Fact]
    public void ClearingPersistent_InAPartialFormCopyOfAnInteriorCell_MovesTheRecordIntoItsTemporaryGroup()
    {
        var result = SetFlags(_persistent, 0);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["PartialTemp", "PartialPersist"], Group("Temporary"));
    }
}
