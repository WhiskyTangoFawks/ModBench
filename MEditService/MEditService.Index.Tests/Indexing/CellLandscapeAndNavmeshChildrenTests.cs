using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

public sealed class CellLandscapeAndNavmeshChildrenTests : IDisposable
{
    private static readonly PluginAddress Key = new("Land.esp", PluginOrigin.DataDirectory);

    private readonly PluginFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly string _landed;
    private readonly string _landOnly;
    private readonly string _bare;
    private readonly string _landscape;
    private readonly string _navmesh;
    private readonly string _raider;

    public CellLandscapeAndNavmeshChildrenTests()
    {
        FormKey landed = default, landOnly = default, bare = default, landscape = default, navmesh = default, raider = default;
        _fixture = new PluginFixtureBuilder("cell-land-navm")
            .WithPlugin(Key.Name, mod =>
            {
                var landedCell = new Cell(mod) { EditorID = "LandedCell" };
                var land = new Landscape(mod);
                var nav = new NavigationMesh(mod);
                var placed = new PlacedObject(mod) { EditorID = "raiderRef" };
                landedCell.Landscape = land;
                landedCell.NavigationMeshes.Add(nav);
                landedCell.Temporary.Add(placed);

                var landOnlyCell = new Cell(mod) { EditorID = "LandOnlyCell", Landscape = new Landscape(mod) };
                var bareCell = new Cell(mod) { EditorID = "BareCell" };
                var sub = new CellSubBlock { BlockNumber = 0 };
                sub.Cells.Add(landedCell);
                sub.Cells.Add(landOnlyCell);
                sub.Cells.Add(bareCell);
                var block = new CellBlock { BlockNumber = 0 };
                block.SubBlocks.Add(sub);
                mod.Cells.Records.Add(block);
                (landed, landOnly, bare, landscape, navmesh, raider) =
                    (landedCell.FormKey, landOnlyCell.FormKey, bareCell.FormKey, land.FormKey, nav.FormKey, placed.FormKey);
            })
            .Build();
        _index = Indexes.Reconciled(_fixture);
        (_landed, _landOnly, _bare, _landscape, _navmesh, _raider) =
            (landed.ToString(), landOnly.ToString(), bare.ToString(), landscape.ToString(), navmesh.ToString(), raider.ToString());
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public void ACellsTemporaryChildrenHoldItsLandscapeAndNavmeshesWithItsPlacedObjects()
    {
        var references = _index.Worldspaces.GetCellChildRecords(Key, _landed);

        Assert.Empty(references.Persistent);
        Assert.Equal(
            new[] { (_landscape, "land"), (_navmesh, "navm"), (_raider, "refr") }.OrderBy(c => c.Item1, StringComparer.Ordinal),
            references.Temporary.Select(t => (t.FormKey, t.RecordType)));
    }

    [Fact]
    public void ACellHoldingOnlyALandscapeHasChildren()
    {
        var cells = _index.Worldspaces.GetInteriorCells(Key).SelectMany(block => block.SubBlocks).SelectMany(sub => sub.Cells).ToList();

        Assert.True(cells.Single(c => c.FormKey == _landOnly).HasChildren);
        Assert.False(cells.Single(c => c.FormKey == _bare).HasChildren);
    }

    [Fact]
    public void TwoPluginsSharingAFilenameEachListOnlyTheirOwnLandscapeAndNavmeshes()
    {
        var first = new PluginAddress("Twin.esp", "ModA");
        var second = new PluginAddress("Twin.esp", "ModB");
        string cellKey = "";
        using var plugins = new PluginFixtureBuilder("cell-land-origin")
            .WithPlugin(first.Name, mod => cellKey = TwinCell(mod, withNavmesh: false), origin: first.Origin)
            .WithPlugin(second.Name, mod => TwinCell(mod, withNavmesh: true), origin: second.Origin)
            .BuildScattered();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        Assert.Equal(
            ["land"],
            index.WithWinner(holder, plugins.GameDirectory, plugins.Plugins, first.Origin)
                .Worldspaces.GetCellChildRecords(first, cellKey).Temporary.Select(t => t.RecordType));
        Assert.Equal(
            ["land", "navm"],
            index.WithWinner(holder, plugins.GameDirectory, plugins.Plugins, second.Origin)
                .Worldspaces.GetCellChildRecords(second, cellKey).Temporary.Select(t => t.RecordType));
    }

    private static string TwinCell(Fallout4Mod mod, bool withNavmesh)
    {
        var cell = new Cell(mod) { EditorID = "TwinCell", Landscape = new Landscape(mod) };
        if (withNavmesh) cell.NavigationMeshes.Add(new NavigationMesh(mod));
        var sub = new CellSubBlock { BlockNumber = 0 };
        sub.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0 };
        block.SubBlocks.Add(sub);
        mod.Cells.Records.Add(block);
        return cell.FormKey.ToString();
    }
}
