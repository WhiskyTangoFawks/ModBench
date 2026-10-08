using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

public sealed class LandscapeAndNavmeshReferenceTests : IDisposable
{
    private readonly PluginFixtureData _fixture;
    private readonly string _door;
    private readonly string _texture;
    private readonly string _navmesh;
    private readonly string _landscape;
    private readonly string _infoMap;

    public LandscapeAndNavmeshReferenceTests()
    {
        FormKey door = default, texture = default, navmesh = default, landscape = default, infoMap = default;
        _fixture = new PluginFixtureBuilder("landscape-navmesh-refs")
            .WithPlugin("Base.esm", mod =>
            {
                var ltex = mod.LandscapeTextures.AddNew("Dirt");
                var cell = new Cell(mod) { EditorID = "NavCell" };
                var placedDoor = new PlacedObject(mod) { EditorID = "CellDoor" };
                cell.Persistent.Add(placedDoor);
                var nav = new NavigationMesh(mod)
                {
                    NavmeshGeometry = new NavmeshGeometry
                    {
                        Parent = new CellNavmeshParent { Parent = cell.ToLink() },
                        DoorTriangles = [new DoorTriangle { Door = placedDoor.ToLink() }],
                    },
                };
                cell.NavigationMeshes.Add(nav);
                var land = new Landscape(mod) { Textures = [ltex.ToLink()] };
                cell.Landscape = land;
                var subBlock = new CellSubBlock { BlockNumber = 0 };
                subBlock.Cells.Add(cell);
                var block = new CellBlock { BlockNumber = 0 };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);

                var navi = mod.NavigationMeshInfoMaps.AddNew("InfoMap");
                navi.MapInfos.Add(new NavigationMapInfo
                {
                    NavigationMesh = nav.ToLink(),
                    LinkedDoors = [new LinkedDoor { Door = placedDoor.ToLink() }],
                    Parent = new NavigationMapInfoCellParent { Cell = cell.ToLink() },
                });

                (door, texture, navmesh, landscape, infoMap) =
                    (placedDoor.FormKey, ltex.FormKey, nav.FormKey, land.FormKey, navi.FormKey);
            })
            .WithPlugin("Patch.esp", (mod, masters) => mod.Cells.Records.Add(masters[0].Cells.Records[0].DeepCopy()))
            .Build();
        (_door, _texture, _navmesh, _landscape, _infoMap) =
            (door.ToString(), texture.ToString(), navmesh.ToString(), landscape.ToString(), infoMap.ToString());
    }

    public void Dispose() => _fixture.Dispose();

    private static List<(string Referrer, string Plugin)> ReferrersOf(OpenedIndex index, string target) =>
        [.. index.Records.GetReferences(target).Select(r => (r.FormKey, r.Plugin)).Order()];

    [Fact]
    public void ADoorListsTheNavmeshFromEachPluginThatHoldsIt_AndTheInfoMapThatLinksIt()
    {
        using var index = Indexes.Reconciled(_fixture);

        Assert.Equal(
            [.. new[] { (_navmesh, "Base.esm"), (_navmesh, "Patch.esp"), (_infoMap, "Base.esm") }.Order()],
            ReferrersOf(index, _door));
    }

    [Fact]
    public void ALandscapeTextureListsTheLandscapeFromEachPluginThatHoldsIt()
    {
        using var index = Indexes.Reconciled(_fixture);

        Assert.Equal(
            [.. new[] { (_landscape, "Base.esm"), (_landscape, "Patch.esp") }.Order()],
            ReferrersOf(index, _texture));
    }

    [Fact]
    public void ANavmeshListsTheInfoMapThatMapsIt()
    {
        using var index = Indexes.Reconciled(_fixture);

        Assert.Equal([(_infoMap, "Base.esm")], ReferrersOf(index, _navmesh));
    }
}
