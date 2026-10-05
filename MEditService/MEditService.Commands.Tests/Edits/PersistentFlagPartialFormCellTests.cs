using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class PersistentFlagPartialFormCellTests : IDisposable
{
    private const int Persistent = 0x0400, PartialForm = 0x4000;
    private const string OverrideOrigin = "OverrideMod";

    private readonly ScratchDirectory _root = new("medit-persistent-partial-");
    private readonly PluginAddress _override = new("Override.esp", OverrideOrigin);
    private readonly FormKey _cell, _temporary, _persistent;
    private readonly EditRecordHandler _handler;

    public PersistentFlagPartialFormCellTests()
    {
        var masterFolder = Directory.CreateDirectory(Path.Combine(_root, "mods", "MasterMod")).FullName;
        var overrideFolder = Directory.CreateDirectory(Path.Combine(_root, "mods", OverrideOrigin)).FullName;
        var gameDirectory = Directory.CreateDirectory(Path.Combine(_root, "game")).FullName;

        var master = new Fallout4Mod(ModKey.FromFileName("Master.esm"), Fallout4Release.Fallout4);
        var masterCell = new Cell(master) { EditorID = "Inside", Flags = Cell.Flag.IsInteriorCell };
        master.Cells.Records.Add(InteriorBlockHolding(masterCell));
        var masterPath = Path.Combine(masterFolder, "Master.esm");
        master.WriteToBinary(masterPath);

        var copy = new Fallout4Mod(ModKey.FromFileName(_override.Name), Fallout4Release.Fallout4);
        copy.ModHeader.MasterReferences.Add(new MasterReference { Master = master.ModKey });
        var partialCell = new Cell(masterCell.FormKey, Fallout4Release.Fallout4) { EditorID = "Inside", MajorRecordFlagsRaw = PartialForm };
        var temporary = new PlacedObject(copy) { EditorID = "PartialTemp" };
        var persistent = new PlacedObject(copy) { EditorID = "PartialPersist", MajorRecordFlagsRaw = Persistent };
        partialCell.Temporary.Add(temporary);
        partialCell.Persistent.Add(persistent);
        copy.Cells.Records.Add(InteriorBlockHolding(partialCell));
        var overridePath = Path.Combine(overrideFolder, _override.Name);
        copy.WriteToBinary(overridePath);
        (_cell, _temporary, _persistent) = (masterCell.FormKey, temporary.FormKey, persistent.FormKey);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDirectory, _root, GameRelease.Fallout4,
            [
                new LoadOrderEntry("Master.esm", masterPath, "MasterMod", Slot: 0, Enabled: true, Winning: true),
                new LoadOrderEntry(_override.Name, overridePath, OverrideOrigin, Slot: 1, Enabled: true, Winning: true),
            ]);
        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(loadOrder, OverrideOrigin).GetAwaiter().GetResult();
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        _handler = TestEditService.EditHandler(holder);
    }

    public void Dispose() => _root.Dispose();

    private static CellBlock InteriorBlockHolding(Cell cell)
    {
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        return block;
    }

    private RecordEditResult SetFlags(FormKey placed, int raw) =>
        _handler.Edit(
            _override, placed.ToString(),
            SetAt(JsonDocument.Parse(raw.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));

    private List<string> Group(string group)
    {
        var cell = JsonNode.Parse(
            TrackedTree.Document(Path.Combine(_root, "mods", OverrideOrigin), _override, _cell.ToString()).Require().Body).Require();
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
