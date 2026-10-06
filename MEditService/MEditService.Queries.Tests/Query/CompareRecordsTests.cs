using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.Query;

public sealed class CompareRecordsTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress BasePlugin = new("Base.esm", "Data");
    private static readonly PluginAddress ModPlugin = new("Mod.esp", "Data");
    private static readonly PluginAddress InactivePlugin = new("Off.esp", "Data");
    private static readonly string[] Fields = ["Name", "Items"];

    private readonly Fallout4Mod _baseMod = new(ModKey.FromFileName("Base.esm"), Fallout4Release.Fallout4);
    private readonly Fallout4Mod _modMod = new(ModKey.FromFileName("Mod.esp"), Fallout4Release.Fallout4);
    private readonly Container _chest;
    private readonly Container _otherChest;
    private readonly Weapon _sword;
    private readonly Cell _room;
    private readonly PlacedObject _placed;
    private readonly RecordQueryService _service;

    public CompareRecordsTests()
    {
        _chest = new Container(_baseMod) { EditorID = "Chest", Name = "Chest", Items = [Entry(new FormKey(_baseMod.ModKey, 0x900))] };
        _otherChest = new Container(_modMod) { EditorID = "Other", Name = "Other", Items = [Entry(new FormKey(_baseMod.ModKey, 0x901))] };
        _sword = new Weapon(_modMod) { EditorID = "Sword", Name = "Sword" };
        _placed = new PlacedObject(_modMod) { EditorID = "Placed" };
        _room = new Cell(_modMod) { EditorID = "Room" };
        _room.Temporary.Add(_placed);
        var rows = new[]
        {
            Row(_chest, BasePlugin, 0, "cont"),
            Row(_otherChest, ModPlugin, 1, "cont"),
            Row(_sword, ModPlugin, 1, "weap"),
            Row(_room, ModPlugin, 1, "cell"),
            Row(_placed, ModPlugin, 1, "refr"),
        };
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, IsBlueprint: false, Masters: [], RecordCount: 1, IsMedium: false),
            [ModPlugin] = new(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: ["Base.esm"], RecordCount: 2, IsMedium: false),
        };
        _service = new RecordQueryService(
            new FakeIndex(new FakeReads(opened, rows) { TextFieldNames = Fields }),
            FakeLoadOrder.Of(Release,
                new LoadOrderEntry("Base.esm", "Base.esm", "Data", 0, Enabled: true, Winning: true),
                new LoadOrderEntry("Mod.esp", "Mod.esp", "Data", 1, Enabled: true, Winning: true)),
            SharedSchemaReflector.Instance);
    }

    private static ContainerEntry Entry(FormKey item) =>
        new() { Item = new ContainerItem { Item = new FormLink<IItemGetter>(item), Count = 1 } };

    private static FakeRow Row(IMajorRecordGetter record, PluginAddress plugin, int loadOrderIndex, string recordType) =>
        new(plugin, loadOrderIndex, true, RealDocuments.Of(record, plugin, loadOrderIndex, true, Release, recordType, Fields));

    private static RecordCopy Copy(IMajorRecordGetter record, PluginAddress plugin, string? text = null) =>
        new(record.FormKey.ToString(), plugin, text);

    private CompareResult Compare(params RecordCopy[] copies) =>
        _service.GetCompareRecords(copies) ?? throw new InvalidOperationException("Expected the copies to compare.");

    private static string Column(CompareResult compare, int index) =>
        compare.Overrides[index].Column ?? throw new InvalidOperationException("Expected the column to be named.");

    private static IEnumerable<FieldDiff> Flatten(IEnumerable<FieldDiff> diffs) =>
        diffs.SelectMany(d => new[] { d }.Concat(Flatten(d.Children ?? [])));

    [Fact]
    public void EachCopyIsAColumn_InTheOrderGiven()
    {
        var compare = Compare(Copy(_otherChest, ModPlugin), Copy(_chest, BasePlugin));

        Assert.Equal([ModPlugin, BasePlugin], compare.Overrides.Select(o => new PluginAddress(o.Plugin, o.Origin)));
        Assert.Equal([_otherChest.FormKey.ToString(), _chest.FormKey.ToString()], compare.Overrides.Select(o => o.FormKey));
    }

    [Fact]
    public void TwoCopiesFromOnePlugin_AreTwoColumns_EachCarryingItsOwnCells()
    {
        var compare = Compare(Copy(_otherChest, ModPlugin), Copy(_sword, ModPlugin));

        Assert.Equal(2, compare.Overrides.Select(o => o.Column).Distinct().Count());
        var items = compare.Diffs.Single(d => d.FieldName == "Items");
        Assert.NotNull(items.Values[Column(compare, 0)]);
        Assert.Null(items.Values[Column(compare, 1)]);
    }

    [Fact]
    public void TheSameCopyTwice_IsTwoColumns()
    {
        var compare = Compare(Copy(_chest, BasePlugin), Copy(_chest, BasePlugin));

        Assert.Equal(2, compare.Overrides.Select(o => o.Column).Distinct().Count());
    }

    [Fact]
    public void RecordsOfDifferentTypes_HaveARowForEveryFieldAnyColumnHolds_EmptyWhereTheColumnLacksIt()
    {
        var compare = Compare(Copy(_sword, ModPlugin), Copy(_chest, BasePlugin));

        var rows = compare.Diffs.ToDictionary(d => d.FieldName);
        Assert.Equal(["Items", "Name"], rows.Keys.Order());
        Assert.Null(rows["Items"].Values[Column(compare, 0)]);
        Assert.NotNull(rows["Items"].Values[Column(compare, 1)]);
        Assert.NotNull(rows["Name"].Values[Column(compare, 0)]);
        Assert.NotNull(rows["Name"].Values[Column(compare, 1)]);
    }

    [Fact]
    public void CopiesThatDiffer_CarryNoConflictState()
    {
        var compare = Compare(Copy(_chest, BasePlugin), Copy(_otherChest, ModPlugin));

        Assert.Contains(compare.Diffs, d => d.FieldName == "Items" && d.Values[Column(compare, 0)] is not null && d.Values[Column(compare, 1)] is not null);
        Assert.All(compare.Overrides, o => Assert.Null(o.ConflictThis));
        Assert.All(Flatten(compare.Diffs), d =>
        {
            Assert.Empty(d.CellStates);
            Assert.Equal(ConflictAll.NoConflict, d.ConflictAll);
        });
        Assert.Equal(ConflictAll.NoConflict, compare.ConflictAll);
    }

    [Fact]
    public void ACopyWithText_IsAColumnReadFromIt_EvenWhenItsPluginIsNotActive()
    {
        var edited = new Container(_chest.FormKey, Fallout4Release.Fallout4)
        {
            EditorID = "Chest",
            Name = "Chest",
            Items = [Entry(new FormKey(_baseMod.ModKey, 0x901))],
        };

        var compare = Compare(Copy(_chest, InactivePlugin, RealDocuments.BodyOf(edited, Release)), Copy(_chest, BasePlugin));

        Assert.Equal([InactivePlugin.Name, BasePlugin.Name], compare.Overrides.Select(o => o.Plugin));
        Assert.Null(compare.Overrides[0].ParseDiagnosis);
        var items = compare.Diffs.Single(d => d.FieldName == "Items");
        Assert.Contains("000901", items.Values[Column(compare, 0)]?.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain("000901", items.Values[Column(compare, 1)]?.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void AChildsCopyWithItsContainersText_IsTheChildReadFromIt()
    {
        _placed.EditorID = "Edited";

        var compare = Compare(Copy(_placed, ModPlugin, RealDocuments.BodyOf(_room, Release)));

        Assert.Equal(("Edited", null), (compare.Overrides.Single().EditorId, compare.Overrides.Single().ParseDiagnosis));
    }

    [Fact]
    public void ACopyNoPluginHolds_AndNoTextGives_FailsTheWholeQuery()
    {
        Assert.Null(_service.GetCompareRecords([Copy(_chest, BasePlugin), Copy(_sword, BasePlugin)]));
    }

    [Fact]
    public void TheRecordTypeNameIsTheFirstCopys()
    {
        Assert.Equal("Weapon", Compare(Copy(_sword, ModPlugin), Copy(_chest, BasePlugin)).RecordTypeName);
    }
}
