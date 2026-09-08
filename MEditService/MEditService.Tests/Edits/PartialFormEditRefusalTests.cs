using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Edits;

public sealed class PartialFormEditRefusalTests : IDisposable
{
    private const int PartialFormBit = 0x0000_4000;
    private const string PluginName = "PartialFormEdit.esp";
    private const string Origin = "PartialFormEditMod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-partialform-mod-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-partialform-game-").FullName;

    public PluginKey Plugin { get; } = new(PluginName, Origin);
    public LoadOrder LoadOrder { get; }
    public EditRecordHandler EditHandler { get; }
    public FormKey PartialCell { get; }
    public FormKey OrdinaryNpc { get; }
    public FormKey ChildRef { get; }

    public PartialFormEditRefusalTests()
    {
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

        mod.WriteToBinary(pluginPath);
        PartialCell = cell.FormKey;
        OrdinaryNpc = npc.FormKey;
        ChildRef = childRef.FormKey;

        LoadOrder = LoadOrder.From(
            _gameDirectory, _gameDirectory, GameRelease.Fallout4,
            [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]);
        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(LoadOrder, [Plugin], Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        var holder = new LoadOrderHolder();
        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
    }

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); } catch { /* best-effort cleanup */ }
        try { Directory.Delete(_gameDirectory, recursive: true); } catch { /* best-effort cleanup */ }
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
        var before = File.ReadAllText(SourcePath());

        Service().Set(Plugin, PartialCell.ToString(), "WaterHeight", Json("50.0"));

        Assert.Equal(before, File.ReadAllText(SourcePath()));
    }

    // xEdit's own CanAssignInternal (wbImplementation.pas:9905-9914) explicitly allows
    // EDID assignment on a Partial Form record — ADR-0034 makes that binding. EditorID is an
    // ordinary, already-writable field (RecordFieldWriter.EditorIdFieldPath), so it needs no
    // header write path.
    [Fact]
    public void EditField_EditorIdOnPartialFormRecord_Succeeds()
    {
        var result = Service().Set(Plugin, PartialCell.ToString(), "EditorID", Json("\"RenamedPartialCell\""));

        Assert.True(result.Applied);
    }

    [Fact]
    public void EditField_NonHeaderFieldOnOrdinaryRecord_IsUnaffected()
    {
        // A non-Partial-Form record beside the fixture — the guard must not blanket-refuse the rest
        // of the plugin.
        var result = Service().Set(Plugin, OrdinaryNpc.ToString(), "Name", Json("""{"Value": "New Name"}"""));

        Assert.True(result.Applied);
    }

    [Fact]
    public void EditField_ChildRefInsideAPartialFormCell_IsUnaffected()
    {
        // CONTEXT.md's Partial Form entry: "children are unaffected — they are separate records".
        var result = Service().Set(Plugin, ChildRef.ToString(), "Scale", Json("2.5"));

        Assert.True(result.Applied);
    }

    private string SourcePath() =>
        Directory.EnumerateFiles(_modFolder, "RecordData.json", SearchOption.AllDirectories)
            .Single(p => p.Contains("PartialCell", StringComparison.Ordinal));

    private static System.Text.Json.JsonElement Json(string json) =>
        System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(json);
}
