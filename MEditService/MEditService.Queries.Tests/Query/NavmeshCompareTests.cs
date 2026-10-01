using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.Query;

public sealed class NavmeshCompareTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress BasePlugin = new("Base.esm", "Data");
    private static readonly PluginAddress TopPlugin = new("Top.esp", "Data");
    private static readonly string[] Fields = ["NavmeshGeometry", "PreCutMapEntries", "MapInfos", "PreferredPathing"];

    private static readonly ModKey Base = ModKey.FromFileName(BasePlugin.Name);
    private static readonly FormKey NavmeshKey = new(Base, 0x800);
    private static readonly FormKey InfoMapKey = new(Base, 0x801);
    private static readonly FormKey Cell = new(Base, 0x802);
    private static readonly FormKey DoorA = new(Base, 0x803);
    private static readonly FormKey DoorB = new(Base, 0x804);
    private static readonly FormKey NavA = new(Base, 0x805);
    private static readonly FormKey NavB = new(Base, 0x806);

    private readonly RecordQueryService _service;

    public NavmeshCompareTests()
    {
        var rows = new[]
        {
            Row(Navmesh(reversed: false), BasePlugin, 0, isWinner: false, "navm"),
            Row(Navmesh(reversed: true), TopPlugin, 1, isWinner: true, "navm"),
            Row(InfoMap(reversed: false), BasePlugin, 0, isWinner: false, "navi"),
            Row(InfoMap(reversed: true), TopPlugin, 1, isWinner: true, "navi"),
        };
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, IsBlueprint: false, Masters: [], RecordCount: 2),
            [TopPlugin] = new(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: [BasePlugin.Name], RecordCount: 2),
        };
        var plugins = new[]
        {
            new LoadOrderEntry(BasePlugin.Name, BasePlugin.Name, "Data", 0, Enabled: true, Winning: true),
            new LoadOrderEntry(TopPlugin.Name, TopPlugin.Name, "Data", 1, Enabled: true, Winning: true),
        };
        _service = new RecordQueryService(
            new FakeIndex(new FakeReads(opened, rows)), FakeLoadOrder.Of(Release, plugins), SharedSchemaReflector.Instance, new ConflictClassifier());
    }

    private static IEnumerable<T> InOrder<T>(bool reversed, params T[] items) => reversed ? items.Reverse() : items;

    private static NavigationMesh Navmesh(bool reversed) => new(NavmeshKey, Fallout4Release.Fallout4)
    {
        NavmeshGeometry = new NavmeshGeometry
        {
            Parent = new CellNavmeshParent { Parent = new FormLink<ICellGetter>(Cell) },
            DoorTriangles = [.. InOrder(reversed,
                new DoorTriangle { TriangleBeforeDoor = 1, Door = new FormLink<IPlacedObjectGetter>(DoorA) },
                new DoorTriangle { TriangleBeforeDoor = 2, Door = new FormLink<IPlacedObjectGetter>(DoorB) })],
        },
        PreCutMapEntries = [.. InOrder(reversed,
            new PreCutMapEntry { Reference = new FormLink<IPreCutMapEntryReferenceGetter>(DoorA) },
            new PreCutMapEntry { Reference = new FormLink<IPreCutMapEntryReferenceGetter>(DoorB) })],
    };

    private static NavigationMeshInfoMap InfoMap(bool reversed) => new(InfoMapKey, Fallout4Release.Fallout4)
    {
        MapInfos = [.. InOrder(reversed,
            new NavigationMapInfo
            {
                NavigationMesh = new FormLink<INavigationMeshGetter>(NavA),
                LinkedDoors = [.. InOrder(reversed,
                    new LinkedDoor { Door = new FormLink<IPlacedObjectGetter>(DoorA) },
                    new LinkedDoor { Door = new FormLink<IPlacedObjectGetter>(DoorB) })],
                Parent = new NavigationMapInfoCellParent { Cell = new FormLink<ICellGetter>(Cell) },
            },
            new NavigationMapInfo
            {
                NavigationMesh = new FormLink<INavigationMeshGetter>(NavB),
                Parent = new NavigationMapInfoCellParent { Cell = new FormLink<ICellGetter>(Cell) },
            })],
        PreferredPathing = new PreferredPathing
        {
            NavmeshTree = [.. InOrder(reversed,
                new NavmeshNode { NavMesh = new FormLink<INavigationMeshGetter>(NavA), NodeIndex = 1 },
                new NavmeshNode { NavMesh = new FormLink<INavigationMeshGetter>(NavB), NodeIndex = 2 })],
        },
    };

    private static FakeRow Row(IMajorRecordGetter record, PluginAddress plugin, int loadOrderIndex, bool isWinner, string recordType) =>
        new(plugin, loadOrderIndex, isWinner, RealDocuments.Of(record, plugin, loadOrderIndex, isWinner, Release, recordType, Fields));

    [Theory]
    [InlineData("navm")]
    [InlineData("navi")]
    public void ACopyHoldingEveryKeyedArrayInAnotherOrder_IsIdenticalToMaster(string recordType)
    {
        var record = recordType == "navm" ? NavmeshKey : InfoMapKey;
        var compare = _service.GetCompare(record.ToString())
            ?? throw new InvalidOperationException($"Expected {record} to resolve to a compare result.");

        var topCells = compare.Diffs.Select(d => (d.FieldName, State: d.CellStates[TopPlugin.Name])).ToList();
        Assert.NotEmpty(topCells);
        Assert.All(topCells, cell => Assert.Equal(ConflictThis.IdenticalToMaster, cell.State));
    }
}
