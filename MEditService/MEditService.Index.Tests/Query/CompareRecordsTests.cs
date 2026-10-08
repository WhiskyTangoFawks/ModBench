using MEditService.Codec.Serialization;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Query;

public sealed class CompareRecordsTests : IDisposable
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);
    private static readonly PluginAddress BasePlugin = new("Base.esm", PluginOrigin.DataDirectory);
    private static readonly PluginAddress ModPlugin = new("Mod.esp", PluginOrigin.DataDirectory);
    private static readonly PluginAddress InactivePlugin = new("Off.esp", PluginOrigin.DataDirectory);

    private readonly PluginFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly Container _chest;
    private readonly Container _otherChest;
    private readonly Weapon _sword;
    private readonly Weapon _dagger;

    public CompareRecordsTests()
    {
        Container? chest = null;
        Container? otherChest = null;
        Weapon? sword = null;
        Weapon? dagger = null;
        _fixture = new PluginFixtureBuilder("medit-compare-records")
            .WithPlugin(BasePlugin.Name, mod =>
            {
                chest = new Container(mod) { EditorID = "Chest", Name = "Chest", Items = [Entry(new FormKey(mod.ModKey, 0x900))] };
                mod.Containers.Add(chest);
            })
            .WithPlugin(ModPlugin.Name, mod =>
            {
                otherChest = new Container(mod) { EditorID = "Other", Name = "Other", Items = [Entry(new FormKey(ModKey.FromFileName(BasePlugin.Name), 0x901))] };
                sword = new Weapon(mod) { EditorID = "Sword", Name = "Sword" };
                mod.Containers.Add(otherChest);
                mod.Weapons.Add(sword);
            })
            .WithPlugin(InactivePlugin.Name, mod =>
            {
                dagger = new Weapon(mod) { EditorID = "Dagger", Name = "Dagger" };
                mod.Weapons.Add(dagger);
            }, enabled: false)
            .Build();
        _index = Indexes.Reconciled(_fixture);
        (_chest, _otherChest, _sword, _dagger) = (chest.Require(), otherChest.Require(), sword.Require(), dagger.Require());
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static ContainerEntry Entry(FormKey item) =>
        new() { Item = new ContainerItem { Item = new FormLink<IItemGetter>(item), Count = 1 } };

    private static RecordCopy Copy(IMajorRecordGetter record, PluginAddress plugin, string? text = null) =>
        new(record.FormKey.ToString(), plugin, text);

    private CompareResult Compare(params RecordCopy[] copies) =>
        _index.Records.GetCompareRecords(copies);

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
        var edited = Codec.SerializeToText(_otherChest, GameRelease.Fallout4);

        var compare = Compare(Copy(_chest, InactivePlugin, edited), Copy(_chest, BasePlugin));

        Assert.Equal([InactivePlugin.Name, BasePlugin.Name], compare.Overrides.Select(o => o.Plugin));
        var items = compare.Diffs.Single(d => d.FieldName == "Items");
        Assert.NotEqual(items.Values[Column(compare, 0)]?.ToString(), items.Values[Column(compare, 1)]?.ToString());
    }

    [Fact]
    public void CopiesNoPluginHolds_AndNoTextGives_FailTheWholeQuery_NamingEachOne()
    {
        var sword = Copy(_sword, BasePlugin);
        var chestInMod = Copy(_chest, ModPlugin);
        var message = Assert.Throws<RecordCopiesMissingException>(
            () => _index.Records.GetCompareRecords([Copy(_chest, BasePlugin), sword, chestInMod])).Message;

        Assert.Contains($"{sword.FormKey} in {BasePlugin.Name} ({BasePlugin.Origin})", message);
        Assert.Contains($"{chestInMod.FormKey} in {ModPlugin.Name} ({ModPlugin.Origin})", message);
        Assert.DoesNotContain($"{_chest.FormKey} in {BasePlugin.Name}", message);
    }

    [Fact]
    public void ARecordNoPluginHolds_IsNamedGone_ApartFromACopyMissingOnlyFromItsPlugin()
    {
        var nowhere = new RecordCopy("00DEAD:Nowhere.esp", ModPlugin);
        var swordInBase = Copy(_sword, BasePlugin);

        var refusal = Assert.Throws<RecordCopiesMissingException>(
            () => Compare(Copy(_chest, BasePlugin), swordInBase, nowhere));

        Assert.Equal([nowhere.FormKey], refusal.GoneFormKeys);
    }

    [Fact]
    public void ARecordOnlyADisabledPluginHolds_IsNotGone()
    {
        var refusal = Assert.Throws<RecordCopiesMissingException>(() => Compare(Copy(_dagger, BasePlugin)));

        Assert.Empty(refusal.GoneFormKeys);
    }

    [Fact]
    public void TheRecordTypeNameIsTheFirstCopys()
    {
        Assert.Equal("Weapon", Compare(Copy(_sword, ModPlugin), Copy(_chest, BasePlugin)).RecordTypeName);
    }
}
