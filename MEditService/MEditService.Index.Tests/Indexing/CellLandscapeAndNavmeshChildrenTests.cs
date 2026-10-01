using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

public sealed class CellLandscapeAndNavmeshChildrenTests : IDisposable
{
    private static readonly PluginAddress Key = new("Land.esp", "Data");

    private readonly PluginFixtureData _fixture;
    private readonly Indexer _index;
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
        var references = _index.RequireReads().GetCellReferences(Key, _landed);

        Assert.Empty(references.Persistent);
        Assert.Equivalent(
            new[] { (_landscape, "land"), (_navmesh, "navm"), (_raider, "refr") },
            references.Temporary.Select(t => (t.FormKey, t.RecordType)));
    }

    [Fact]
    public void ACellHoldingOnlyALandscapeHasChildren()
    {
        var cells = _index.RequireReads().GetInteriorCells(Key);

        Assert.True(cells.Single(c => c.FormKey == _landOnly).HasChildren);
        Assert.False(cells.Single(c => c.FormKey == _bare).HasChildren);
    }
}
