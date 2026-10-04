using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

public sealed class PartialFormEditRefusalTests : IDisposable
{
    private const int PartialFormBit = 0x0000_4000;
    private const string PluginName = "PartialFormEdit.esp";
    private const string Origin = "PartialFormEditMod";

    private readonly ScratchDirectory _modFolder = new("medit-partialform-mod-");
    private readonly ScratchDirectory _gameDirectory = new("medit-partialform-game-");

    public PluginAddress Plugin { get; } = new(PluginName, Origin);
    public LoadOrderSnapshot LoadOrder { get; }
    public EditRecordHandler EditHandler { get; }
    public FormKey PartialCell { get; }
    public FormKey OrdinaryNpc { get; }
    public FormKey ChildRef { get; }

    public PartialFormEditRefusalTests()
    {
        var holder = new LoadOrderHolder();
        var pluginPath = Path.Combine(_modFolder, PluginName);
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

        TrackedTemplates.WriteTracked(_modFolder, mod);
        PartialCell = cell.FormKey;
        OrdinaryNpc = npc.FormKey;
        ChildRef = childRef.FormKey;

        LoadOrder = SnapshotPlugins.Snapshot(
            _gameDirectory, _gameDirectory, GameRelease.Fallout4,
            [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]);

        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
    }

    public void Dispose()
    {
        _modFolder.Dispose();
        _gameDirectory.Dispose();
    }

    private EditRecordHandler Service() => EditHandler;

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

    private string CellBody() => TrackedTree.Document(_modFolder, Plugin, PartialCell.ToString()).Require().Body;

    private static System.Text.Json.JsonElement Json(string json) =>
        System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(json);
}
