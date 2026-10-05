using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.Index.Tests.RealData;

public sealed class WorldspaceCellFullNameIndexingTests : IDisposable
{
    private const string PluginName = "CellFullName.esp";
    private const string Origin = "CellFullNameMod";
    private readonly PluginAddress _plugin = new(PluginName, Origin);
    private readonly ScratchDirectory _modFolder = new("medit-cell-fullname-mod-");
    private readonly ScratchDirectory _gameDirectory = new("medit-cell-fullname-game-");
    private readonly OpenedIndex _index;
    private readonly string _worldspaceFormKey;

    public WorldspaceCellFullNameIndexingTests()
    {
        var holder = new LoadOrderHolder();
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

        _index = Indexes.Open(holder);
        _index.Reconcile(holder,
            _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)], GameRelease.Fallout4);

        TrackedMods.Track(pluginPath, _gameDirectory);
        _index.NextSnapshot();
    }

    public void Dispose()
    {
        _index.Dispose();
        _modFolder.Dispose();
        _gameDirectory.Dispose();
    }

    [Fact]
    public void GetWorldspaceCells_ExteriorCellWithFullNameSet_CarriesItThrough()
    {
        var cells = _index.RequireReads().GetWorldspaceCells(_plugin, _worldspaceFormKey);

        var extCell = Assert.Single(cells, c => c.EditorId == "ExtCell");
        Assert.Equal("Sanctuary Hills", extCell.FullName);
    }

    [Fact]
    public void GetWorldspaceCells_TopCellWithNoFullNameSet_FullNameIsNull()
    {
        var cells = _index.RequireReads().GetWorldspaceCells(_plugin, _worldspaceFormKey);

        var topCell = Assert.Single(cells, c => c.EditorId == "TopCell");
        Assert.Null(topCell.FullName);
    }
}
