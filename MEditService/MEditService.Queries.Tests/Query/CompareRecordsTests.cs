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
    private static readonly PluginAddress BasePlugin = new("Base.esm", PluginOrigin.DataDirectory);
    private static readonly PluginAddress ModPlugin = new("Mod.esp", PluginOrigin.DataDirectory);
    private static readonly PluginAddress InactivePlugin = new("Off.esp", PluginOrigin.DataDirectory);

    private readonly Fallout4Mod _baseMod = new(ModKey.FromFileName("Base.esm"), Fallout4Release.Fallout4);
    private readonly Fallout4Mod _modMod = new(ModKey.FromFileName("Mod.esp"), Fallout4Release.Fallout4);
    private readonly Container _chest;
    private readonly Container _otherChest;
    private readonly Weapon _sword;
    private readonly IRecordQueryService _service;

    public CompareRecordsTests()
    {
        _chest = new Container(_baseMod) { EditorID = "Chest", Name = "Chest", Items = [Entry(new FormKey(_baseMod.ModKey, 0x900))] };
        _otherChest = new Container(_modMod) { EditorID = "Other", Name = "Other", Items = [Entry(new FormKey(_baseMod.ModKey, 0x901))] };
        _sword = new Weapon(_modMod) { EditorID = "Sword", Name = "Sword" };
        var rows = new[]
        {
            Row(_chest, BasePlugin, 0),
            Row(_otherChest, ModPlugin, 1),
            Row(_sword, ModPlugin, 1),
        };
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, IsBlueprint: false, Masters: [], RecordCount: 1, IsMedium: false),
            [ModPlugin] = new(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: ["Base.esm"], RecordCount: 2, IsMedium: false),
        };
        _service = QueryHost.Records(
            new FakeIndex(new FakeReads(opened, rows)),
            FakeLoadOrder.Of(Release,
                new LoadOrderEntry("Base.esm", "Base.esm", PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true),
                new LoadOrderEntry("Mod.esp", "Mod.esp", PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true)));
    }

    private static ContainerEntry Entry(FormKey item) =>
        new() { Item = new ContainerItem { Item = new FormLink<IItemGetter>(item), Count = 1 } };

    private static FakeRow Row(IMajorRecordGetter record, PluginAddress plugin, int loadOrderIndex) =>
        new(RealDocuments.Of(record, plugin, loadOrderIndex, Release));

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
        Assert.Equal(["EditorID", "FormKey", "FormVersion", "Items", "MajorRecordFlagsRaw", "Name", "Version2", "VersionControl"], rows.Keys.Order());
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
        var edited = RealDocuments.BodyOf(_otherChest, Release);

        var compare = Compare(Copy(_chest, InactivePlugin, edited), Copy(_chest, BasePlugin));

        Assert.Equal([InactivePlugin.Name, BasePlugin.Name], compare.Overrides.Select(o => o.Plugin));
        var items = compare.Diffs.Single(d => d.FieldName == "Items");
        Assert.NotEqual(items.Values[Column(compare, 0)]?.ToString(), items.Values[Column(compare, 1)]?.ToString());
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
