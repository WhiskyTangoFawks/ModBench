using MEditService.Codec.Serialization;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Query;

public sealed class CompareRecordsTests : IDisposable
{
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
                otherChest = new Container(mod) { EditorID = "Other", Name = "Other", FormVersion = 121, Items = [Entry(new FormKey(ModKey.FromFileName(BasePlugin.Name), 0x901))] };
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
        _index.Queries.GetCompareRecords(copies).Compared();

    private static string Column(CompareResult compare, int index) =>
        compare.Overrides[index].Column ?? throw new InvalidOperationException("Expected the column to be named.");

    private static FieldDiff Row(CompareResult compare, string field) => compare.Diffs.Single(d => d.FieldName == field);

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
    public void CopiesThatDiffer_TakeNoCellState_AndNoCopyState()
    {
        var compare = Compare(Copy(_chest, BasePlugin), Copy(_otherChest, ModPlugin));

        Assert.All(compare.Overrides, o => Assert.Null(o.ConflictThis));
        Assert.All(Flatten(compare.Diffs), d => Assert.Empty(d.CellStates));
    }

    [Fact]
    public void ARowWhereTheCopiesAgree_IsNoConflict_AndWhereTheyDiffer_IsConflictBenign()
    {
        var compare = Compare(Copy(_chest, BasePlugin), Copy(_chest, BasePlugin), Copy(_otherChest, ModPlugin));

        var rows = compare.Diffs.ToDictionary(d => d.FieldName);
        Assert.Equal(ConflictAll.NoConflict, rows["FormVersion"].ConflictAll);
        Assert.Equal(ConflictAll.ConflictBenign, rows["EditorID"].ConflictAll);
        Assert.Equal(ConflictAll.ConflictBenign, rows["Items"].ConflictAll);
        Assert.Equal(ConflictAll.ConflictBenign, compare.ConflictAll);
    }

    [Fact]
    public void ACellIsMasterInTheFocusedColumn_OverrideWhereItsValueIsTheSame_AndConflictLosesWhereItDiffers()
    {
        var compare = Compare(Copy(_chest, BasePlugin), Copy(_chest, BasePlugin), Copy(_otherChest, ModPlugin));
        var (first, second, third) = (Column(compare, 0), Column(compare, 1), Column(compare, 2));

        var byFocus = Row(compare, "EditorID").CellStatesByFocus.Require();

        Assert.Equal(
            new Dictionary<string, ConflictThis> { [first] = ConflictThis.Master, [second] = ConflictThis.Override, [third] = ConflictThis.ConflictLoses },
            byFocus[first]);
        Assert.Equal(
            new Dictionary<string, ConflictThis> { [first] = ConflictThis.ConflictLoses, [second] = ConflictThis.ConflictLoses, [third] = ConflictThis.Master },
            byFocus[third]);
    }

    [Fact]
    public void AnAbsentValueIsAnEmptyKey_OverrideAgainstAbsent_ConflictLosesAgainstAPresentValue()
    {
        var compare = Compare(Copy(_chest, BasePlugin), Copy(_sword, ModPlugin), Copy(_sword, ModPlugin));
        var (chest, sword, otherSword) = (Column(compare, 0), Column(compare, 1), Column(compare, 2));

        var focusedOnSword = Row(compare, "Items").CellStatesByFocus.Require()[sword];

        Assert.Equal(ConflictThis.ConflictLoses, focusedOnSword[chest]);
        Assert.Equal(ConflictThis.Override, focusedOnSword[otherSword]);
    }

    [Fact]
    public void AFieldTheGameIgnoresStillTakesStatesInACompare_ForXEditsPaintRecoloursEveryCell()
    {
        var compare = Compare(Copy(_chest, BasePlugin), Copy(_chest, BasePlugin));

        var byFocus = Row(compare, "FormVersion").CellStatesByFocus.Require();

        Assert.Equal(ConflictThis.Override, byFocus[Column(compare, 0)][Column(compare, 1)]);
    }

    [Fact]
    public void AFieldTheGameIgnores_IsNoConflict_ThoughTheCopiesDiffer()
    {
        var compare = Compare(Copy(_chest, BasePlugin), Copy(_otherChest, ModPlugin));

        Assert.Equal(ConflictAll.NoConflict, Row(compare, "FormVersion").ConflictAll);
    }

    [Fact]
    public void ACopyWithText_IsAColumnReadFromIt_EvenWhenItsPluginIsNotActive()
    {
        var edited = RecordTextCodec.SerializeToText(_otherChest, GameRelease.Fallout4);

        var compare = Compare(Copy(_chest, InactivePlugin, edited), Copy(_chest, BasePlugin));

        Assert.Equal([InactivePlugin.Name, BasePlugin.Name], compare.Overrides.Select(o => o.Plugin));
        var items = compare.Diffs.Single(d => d.FieldName == "Items");
        Assert.NotEqual(items.Values[Column(compare, 0)]?.ToString(), items.Values[Column(compare, 1)]?.ToString());
    }

    [Fact]
    public void CopiesNoPluginHolds_AndNoTextGives_AreAnsweredWithNothingCompared_NamingEachOne()
    {
        var sword = Copy(_sword, BasePlugin);
        var chestInMod = Copy(_chest, ModPlugin);
        var answer = _index.Queries.GetCompareRecords([Copy(_chest, BasePlugin), sword, chestInMod]).Value();

        Assert.Equal([sword, chestInMod], Assert.IsType<CompareRecordsAnswer.Missing>(answer).Copies.Select(m => m.Copy));
    }

    [Fact]
    public void ARecordNoPluginHolds_IsNamedGone_ApartFromACopyMissingOnlyFromItsPlugin()
    {
        var nowhere = new RecordCopy("00DEAD:Nowhere.esp", ModPlugin);
        var swordInBase = Copy(_sword, BasePlugin);

        var answer = _index.Queries.GetCompareRecords([Copy(_chest, BasePlugin), swordInBase, nowhere]).Value();

        Assert.Equal(
            [(nowhere.FormKey, CopyMissingReason.RecordGone), (swordInBase.FormKey, CopyMissingReason.NotInPlugin)],
            Assert.IsType<CompareRecordsAnswer.Missing>(answer).Copies
                .OrderBy(m => m.Reason == CopyMissingReason.NotInPlugin).Select(m => (m.Copy.FormKey, m.Reason)));
    }

    [Fact]
    public void ARecordOnlyADisabledPluginHolds_IsNotGone()
    {
        var answer = _index.Queries.GetCompareRecords([Copy(_dagger, BasePlugin)]).Value();

        Assert.Equal(CopyMissingReason.NotInPlugin, Assert.Single(Assert.IsType<CompareRecordsAnswer.Missing>(answer).Copies).Reason);
    }

    [Fact]
    public void TheRecordTypeNameIsTheFirstCopys()
    {
        Assert.Equal("Weapon", Compare(Copy(_sword, ModPlugin), Copy(_chest, BasePlugin)).RecordTypeName);
    }
}
