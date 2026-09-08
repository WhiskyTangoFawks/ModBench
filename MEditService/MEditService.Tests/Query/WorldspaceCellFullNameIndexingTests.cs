using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.Tests.Query;

/// <summary>Indexes a real Cell through the real <see cref="DuckDbRecordIndex"/> pipeline rather
/// than stubbing the DTO layer: the JSON-path guess driving <c>json_extract_string</c> is unproven
/// until it runs against a document the codec really serialized.</summary>
public sealed class WorldspaceCellFullNameIndexingTests : IDisposable
{
    private const string PluginName = "CellFullName.esp";
    private const string Origin = "CellFullNameMod";
    private readonly PluginKey _plugin = new(PluginName, Origin);
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-cell-fullname-mod-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-cell-fullname-game-").FullName;
    private readonly IndexProjector _index;
    private readonly string _worldspaceFormKey;

    public WorldspaceCellFullNameIndexingTests()
    {
        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var worldspace = new Worldspace(mod) { EditorID = "TestWorld" };
        var topCell = new Cell(mod) { EditorID = "TopCell", WaterHeight = 1f };
        worldspace.TopCell = topCell;

        var extCell = new Cell(mod)
        {
            EditorID = "ExtCell",
            Grid = new CellGrid { Point = new P2Int(3, 4) },
            Name = new TranslatedString(Language.English, "Sanctuary Hills"),
        };
        var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        subBlock.Items.Add(extCell);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        block.Items.Add(subBlock);
        worldspace.SubCells.Add(block);
        mod.Worldspaces.Add(worldspace);

        mod.WriteToBinary(pluginPath);

        _worldspaceFormKey = worldspace.FormKey.ToString();

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

    [Fact]
    public void GetWorldspaceCells_ExteriorCellWithFullNameSet_CarriesItThrough()
    {
        var cells = _index.Projected().GetWorldspaceCells(_plugin, _worldspaceFormKey);

        var extCell = Assert.Single(cells, c => c.EditorId == "ExtCell");
        Assert.Equal("Sanctuary Hills", extCell.FullName);
    }

    [Fact]
    public void GetWorldspaceCells_TopCellWithNoFullNameSet_FullNameIsNull()
    {
        var cells = _index.Projected().GetWorldspaceCells(_plugin, _worldspaceFormKey);

        var topCell = Assert.Single(cells, c => c.EditorId == "TopCell");
        Assert.Null(topCell.FullName);
    }
}
