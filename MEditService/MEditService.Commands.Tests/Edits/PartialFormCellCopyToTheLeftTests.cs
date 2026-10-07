using System.Globalization;
using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class PartialFormCellCopyToTheLeftTests : TestInstance
{
    private const int PartialForm = 0x4000;
    private const string OverrideOrigin = "OverrideMod";

    private readonly PluginAddress _override;
    private readonly FormKey _cell;

    public PartialFormCellCopyToTheLeftTests()
    {
        var master = new Fallout4Mod(ModKey.FromFileName("Fallout4.esm"), Fallout4Release.Fallout4);
        var masterCell = new Cell(master) { EditorID = "Inside", Flags = Cell.Flag.IsInteriorCell };
        master.Cells.Records.Add(CellBlocks.Interior(masterCell));
        Add(master, "MasterMod", tracked: false);

        var copy = new Fallout4Mod(ModKey.FromFileName("Override.esp"), Fallout4Release.Fallout4);
        copy.ModHeader.MasterReferences.Add(new MasterReference { Master = master.ModKey });
        copy.Cells.Records.Add(CellBlocks.Interior(new Cell(masterCell.FormKey, Fallout4Release.Fallout4) { EditorID = "Inside" }));
        _override = Add(copy, OverrideOrigin);
        _cell = masterCell.FormKey;
    }

    [Fact]
    public void SettingPartialForm_OnACopyThatSaysNotWhereItSits_TakesItsPlaceFromTheCopyToItsLeft()
    {
        var result = EditHandler.Edit(
            _override, _cell.ToString(),
            SetAt(JsonDocument.Parse(PartialForm.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));

        Assert.True(result.Applied, result.Message);
    }
}
