using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>
/// #491 AC2 (first half — the header-write half is #539): editing a non-header field of a Partial
/// Form record is refused, typed, before anything is written.
/// </summary>
public sealed class PartialFormEditRefusalTests : IDisposable
{
    private const int PartialFormBit = 0x0000_4000;
    private const string PluginName = "PartialFormEdit.esp";
    private const string Origin = "PartialFormEditMod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-partialform-mod-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-partialform-game-").FullName;
    private readonly SessionManager _sessions;

    public PluginKey Plugin { get; } = new(PluginName, Origin);
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

        _sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)_sessions).LoadExplicit(
            _gameDirectory, [new ExplicitPluginInput(PluginName, pluginPath, Origin, true)], GameRelease.Fallout4);
        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_sessions.Session!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _sessions.Dispose();
        try { Directory.Delete(_modFolder, recursive: true); } catch { /* best-effort cleanup */ }
        try { Directory.Delete(_gameDirectory, recursive: true); } catch { /* best-effort cleanup */ }
    }

    private RecordEditService Service() =>
        new(_sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void EditField_NonHeaderFieldOnPartialFormRecord_IsRefused()
    {
        var result = Service().EditField(Plugin, PartialCell.ToString(), "water_height", Json("50.0"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PartialFormFieldReadOnly, result.Refusal);
    }

    [Fact]
    public void EditField_NonHeaderFieldOnPartialFormRecord_WritesNothing()
    {
        var before = File.ReadAllText(SourcePath());

        Service().EditField(Plugin, PartialCell.ToString(), "water_height", Json("50.0"));

        Assert.Equal(before, File.ReadAllText(SourcePath()));
    }

    [Fact]
    public void EditField_NonHeaderFieldOnOrdinaryRecord_IsUnaffected()
    {
        // A non-Partial-Form record beside the fixture — the guard must not blanket-refuse the rest
        // of the plugin.
        var result = Service().EditField(Plugin, OrdinaryNpc.ToString(), "name", Json("\"New Name\""));

        Assert.True(result.Applied);
    }

    [Fact]
    public void EditField_ChildRefInsideAPartialFormCell_IsUnaffected()
    {
        // CONTEXT.md's Partial Form entry: "children are unaffected — they are separate records".
        var result = Service().EditField(Plugin, ChildRef.ToString(), "scale", Json("2.5"));

        Assert.True(result.Applied);
    }

    private string SourcePath() =>
        Directory.EnumerateFiles(_modFolder, "RecordData.json", SearchOption.AllDirectories)
            .Single(p => p.Contains("PartialCell", StringComparison.Ordinal));

    private static System.Text.Json.JsonElement Json(string json) =>
        System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(json);
}
