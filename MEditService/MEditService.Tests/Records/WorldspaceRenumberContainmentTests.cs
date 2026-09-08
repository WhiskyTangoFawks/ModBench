using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Records;

/// <summary>The counterpart to <see cref="ContainmentRederivationTests"/>: a Worldspace's exterior
/// cells are unreachable from <c>EnumerateChildren</c> (<c>SubCells</c> holds blocks, not records).
/// A self-built mod, since widening the shared fixture is the riskier change.</summary>
public sealed class WorldspaceRenumberContainmentTests : IDisposable
{
    private const string PluginName = "WorldspaceRenumber.esp";
    private const string Origin = "WorldspaceRenumberMod";
    private readonly PluginKey _plugin = new(PluginName, Origin);
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-wrld-renumber-mod-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-wrld-renumber-game-").FullName;
    private readonly IndexProjector _index;
    private readonly string _topCellFormKey;
    private readonly string _extCellFormKey;
    private readonly string _worldspaceFormKey;

    public WorldspaceRenumberContainmentTests()
    {
        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var worldspace = new Worldspace(mod) { EditorID = "TestWorld" };
        var topCell = new Cell(mod) { EditorID = "TopCell", WaterHeight = 1f };
        worldspace.TopCell = topCell;

        var extCell = new Cell(mod) { EditorID = "ExtCell", Grid = new CellGrid { Point = new P2Int(3, 4) } };
        var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        subBlock.Items.Add(extCell);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        block.Items.Add(subBlock);
        worldspace.SubCells.Add(block);
        mod.Worldspaces.Add(worldspace);

        mod.WriteToBinary(pluginPath);

        _worldspaceFormKey = worldspace.FormKey.ToString();
        _topCellFormKey = topCell.FormKey.ToString();
        _extCellFormKey = extCell.FormKey.ToString();

        _index = new IndexProjector(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        _index.Reconcile(
            _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)], GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_index, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _index.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    private ProjectingEditService EditService() =>
        ProjectingEditService.Over(_index);

    // ---- the confirmed gap ----

    [Fact]
    public void RenumberingAWorldspace_RepointsItsExteriorCellsCellLocationRow_ToTheNewFormKey_SameLoadOrder()
    {
        var index = _index.Store!;
        Assert.Equal(_worldspaceFormKey, index.At(RecordRef.Effective).GetCellLocation(_plugin, _extCellFormKey)!.Value.ParentWorldspace);

        var result = EditService().RenumberRecord(_plugin, _worldspaceFormKey);
        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey!;

        Assert.Equal(newFormKey, index.At(RecordRef.Effective).GetCellLocation(_plugin, _extCellFormKey)!.Value.ParentWorldspace);
        Assert.Contains(
            index.At(RecordRef.Effective).GetWorldspaceCells(_plugin, newFormKey),
            c => c.FormKey == _extCellFormKey);
        Assert.DoesNotContain(
            index.At(RecordRef.Effective).GetWorldspaceCells(_plugin, _worldspaceFormKey),
            c => c.FormKey == _extCellFormKey);
    }

    // ---- guard against a duplicate TopCell row ---- RederiveContainmentForRecord's TopCell write
    // deletes-then-inserts keyed by that cell's unchanging cell_form_key, so it clears any existing
    // row whatever the step order.

    [Fact]
    public void RenumberingAWorldspace_LeavesExactlyOneCellLocationRowForItsTopCell_NoDuplicate()
    {
        var index = _index.Store!;

        var result = EditService().RenumberRecord(_plugin, _worldspaceFormKey);
        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey!;

        var cells = index.At(RecordRef.Effective).GetWorldspaceCells(_plugin, newFormKey);
        Assert.Single(cells, c => c.FormKey == _topCellFormKey);
        Assert.Equal(newFormKey, index.At(RecordRef.Effective).GetCellLocation(_plugin, _topCellFormKey)!.Value.ParentWorldspace);
    }

    // ---- parity against a fresh reconcile ingest ----

    [Fact]
    public void AfterRenumberingAWorldspace_AFreshReopen_AgreesWithTheLiveCellLocationRows()
    {
        var result = EditService().RenumberRecord(_plugin, _worldspaceFormKey);
        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey!;

        var live = _index.Projected().GetWorldspaceCells(_plugin, newFormKey)
            .OrderBy(c => c.FormKey).ToList();

        using var reloaded = new IndexProjector(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        reloaded.Reconcile(
            _gameDirectory,
            [new LoadOrderEntry(PluginName, Path.Combine(_modFolder, PluginName), Origin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(reloaded.Status.Failures);

        var freshlyIngested = reloaded.Store!.At(RecordRef.Effective).GetWorldspaceCells(_plugin, newFormKey)
            .OrderBy(c => c.FormKey).ToList();

        Assert.Equal(freshlyIngested, live);
    }
}
