using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

public sealed class PartialFormEditRefusalTests : TestInstance
{
    private const int PartialFormBit = 0x0000_4000;
    private const string PluginName = "PartialFormEdit.esp";
    private const string Origin = "PartialFormEditMod";

    public PluginAddress Plugin { get; }
    public FormKey PartialCell { get; }
    public FormKey OrdinaryNpc { get; }
    public FormKey ChildRef { get; }

    public PartialFormEditRefusalTests()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var cell = new Cell(mod) { EditorID = "PartialCell", WaterHeight = 100f, MajorRecordFlagsRaw = PartialFormBit };
        var childRef = new PlacedObject(mod) { EditorID = "PartialCellRef", Scale = 1f };
        cell.Temporary.Add(childRef);
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);

        var npc = mod.Npcs.AddNew("OrdinaryNpc");

        Plugin = Add(mod, Origin);
        PartialCell = cell.FormKey;
        OrdinaryNpc = npc.FormKey;
        ChildRef = childRef.FormKey;
    }

    private TestEditor Service() => EditHandler;

    [Fact]
    public void EditField_NonHeaderFieldOnPartialFormRecord_IsRefused()
    {
        var result = Service().Set(Plugin, PartialCell.ToString(), "WaterHeight", Json("50.0"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PartialFormFieldReadOnly, result.Refusal);
    }

    [Fact]
    public void EditField_NonHeaderFieldOnPartialFormRecord_WritesNothing()
    {
        var before = CellBody();

        Service().Set(Plugin, PartialCell.ToString(), "WaterHeight", Json("50.0"));

        Assert.Equal(before, CellBody());
    }

    [Fact]
    public void EditField_EditorIdOnPartialFormRecord_Succeeds()
    {
        var result = Service().Set(Plugin, PartialCell.ToString(), "EditorID", Json("\"RenamedPartialCell\""));

        Assert.True(result.Applied);
    }

    [Fact]
    public void EditField_NonHeaderFieldOnOrdinaryRecord_IsUnaffected()
    {
        var result = Service().Set(Plugin, OrdinaryNpc.ToString(), "Name", Json("""{"Value": "New Name"}"""));

        Assert.True(result.Applied);
    }

    [Fact]
    public void EditField_ChildRefInsideAPartialFormCell_IsUnaffected()
    {
        var result = Service().Set(Plugin, ChildRef.ToString(), "Scale", Json("2.5"));

        Assert.True(result.Applied);
    }

    private string CellBody() => TrackedTree.Document(ModFolderOf(Plugin), Plugin, PartialCell.ToString()).Require().Body;

    private static System.Text.Json.JsonElement Json(string json) =>
        System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(json);
}
