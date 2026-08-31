using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>
/// Native renumber of a container's own FormKey (here, a Worldspace) leaves other records'
/// stale pointers into it. <see cref="ContainmentRederivationTests"/> covers the
/// "renumbered record's own children" direction; this is the mirror gap —
/// <c>cell_location.parent_worldspace</c> for a Worldspace's <i>exterior</i> cells, which
/// <c>ContainerChildFields.EnumerateChildren</c> can never reach (<c>Worldspace.SubCells</c> holds
/// <c>WorldspaceBlock</c>, not <see cref="Mutagen.Bethesda.Plugins.Records.IMajorRecordGetter"/>, so
/// <c>DuckDbRecordIndex.RederiveContainmentForRecord</c> only ever recurses into
/// <c>TopCell</c>). A self-built inline mod, not the shared <c>ContainerModFixture</c> — the same
/// choice <see cref="RecordEditServiceContainerDeleteRenumberTests"/>'s own
/// <c>RenumberingARecordReferencedByAContainer...</c> test makes, for the same reason: widening a
/// fixture 4+ other suites depend on is a bigger, riskier change than a small local one.
/// </summary>
public sealed class WorldspaceRenumberContainmentTests : IDisposable
{
    private const string PluginName = "WorldspaceRenumber.esp";
    private const string Origin = "WorldspaceRenumberMod";
    private readonly PluginKey _plugin = new(PluginName, Origin);
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-wrld-renumber-mod-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-wrld-renumber-game-").FullName;
    private readonly LoadOrderMirror _mirror;
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

        _mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)_mirror).Reconcile(
            _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)], GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _mirror.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    private RecordEditService EditService() =>
        new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    // ---- the confirmed gap ----

    [Fact]
    public void RenumberingAWorldspace_RepointsItsExteriorCellsCellLocationRow_ToTheNewFormKey_SameLoadOrder()
    {
        var index = _mirror.Index!;
        Assert.Equal(_worldspaceFormKey, index.GetCellLocation(_plugin, _extCellFormKey)!.Value.ParentWorldspace);

        var result = EditService().RenumberRecord(_plugin, _worldspaceFormKey);
        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey!;

        Assert.Equal(newFormKey, index.GetCellLocation(_plugin, _extCellFormKey)!.Value.ParentWorldspace);
        Assert.Contains(
            index.GetWorldspaceCells(_plugin, newFormKey),
            c => c.FormKey == _extCellFormKey);
        Assert.DoesNotContain(
            index.GetWorldspaceCells(_plugin, _worldspaceFormKey),
            c => c.FormKey == _extCellFormKey);
    }

    // ---- guard against a duplicate TopCell row ----
    //
    // A plausible wrong implementation calls RepointCellLocationParent *before*
    // CreateWorkingTreeRecord instead of after (alongside RepointContainerChildParent) — applied and
    // run directly against this test: it still passed, exactly one row either way. The reason is
    // RederiveContainmentForRecord's own TopCell write deletes-then-inserts keyed by that cell's own
    // unchanging cell_form_key, not by parent_worldspace, so it unconditionally clears whatever row
    // already exists for TopCell regardless of order. Kept anyway as a real regression guard on that
    // invariant — see IRecordIndex.RepointCellLocationParent's own doc comment.

    [Fact]
    public void RenumberingAWorldspace_LeavesExactlyOneCellLocationRowForItsTopCell_NoDuplicate()
    {
        var index = _mirror.Index!;

        var result = EditService().RenumberRecord(_plugin, _worldspaceFormKey);
        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey!;

        var cells = index.GetWorldspaceCells(_plugin, newFormKey);
        Assert.Single(cells, c => c.FormKey == _topCellFormKey);
        Assert.Equal(newFormKey, index.GetCellLocation(_plugin, _topCellFormKey)!.Value.ParentWorldspace);
    }

    // ---- parity against a fresh reconcile ingest ----

    [Fact]
    public void AfterRenumberingAWorldspace_AFreshReopen_AgreesWithTheLiveCellLocationRows()
    {
        var result = EditService().RenumberRecord(_plugin, _worldspaceFormKey);
        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey!;

        var live = _mirror.Index!.GetWorldspaceCells(_plugin, newFormKey)
            .OrderBy(c => c.FormKey).ToList();

        using var reloaded = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)reloaded).Reconcile(
            _gameDirectory,
            [new LoadOrderEntry(PluginName, Path.Combine(_modFolder, PluginName), Origin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        Assert.Empty(((ILoadOrderMirror)reloaded).LoadOrder!.LoadFailures);

        var freshlyIngested = reloaded.Index!.GetWorldspaceCells(_plugin, newFormKey)
            .OrderBy(c => c.FormKey).ToList();

        Assert.Equal(freshlyIngested, live);
    }
}
