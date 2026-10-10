using MEditService.Codec.Serialization;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class CompareFromTextTests : IDisposable
{
    private static readonly PluginAddress BasePlugin = new("Base.esm", PluginOrigin.DataDirectory);
    private static readonly PluginAddress ModPlugin = new("Mod.esp", PluginOrigin.DataDirectory);
    private static readonly PluginAddress GapPlugin = new("Gap.esp", PluginOrigin.DataDirectory);
    private static readonly PluginAddress InactivePlugin = new("Off.esp", PluginOrigin.DataDirectory);
    private static readonly ModKey Base = ModKey.FromFileName(BasePlugin.Name);
    private static readonly FormKey Chest = new(Base, 0x800);

    private static readonly Container OtherChest = new(new FormKey(ModKey.FromFileName(ModPlugin.Name), 0x800), Fallout4Release.Fallout4)
    {
        EditorID = "Other",
        Name = "Other",
        Items = [Entry(new FormKey(Base, 0x901))],
    };

    private readonly PluginFixtureData _fixture;
    private readonly OpenedIndex _index;

    public CompareFromTextTests()
    {
        _fixture = new PluginFixtureBuilder("medit-compare-from-text")
            .WithPlugin(BasePlugin.Name, mod => mod.Containers.Add(ChestCopy()))
            .WithPlugin(GapPlugin.Name)
            .WithPlugin(ModPlugin.Name, mod => mod.Containers.Add(ChestCopy()))
            .Build();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static Container ChestCopy() =>
        new(Chest, Fallout4Release.Fallout4) { EditorID = "Chest", Name = "Chest", Items = [Entry(new FormKey(Base, 0x900))] };

    private static ContainerEntry Entry(FormKey item) =>
        new() { Item = new ContainerItem { Item = new FormLink<IItemGetter>(item), Count = 1 } };

    private static string OtherChestText => RecordTextCodec.SerializeToText(OtherChest, GameRelease.Fallout4);

    private CompareResult Compare(PluginAddress plugin, string text) =>
        _index.Records.GetCompare(Chest.ToString(), new CopyText(plugin, text)).Value()
        ?? throw new InvalidOperationException("Expected the record to compare.");

    private static PluginAddress AddressOf(CompareOverride column) => new(column.Plugin, column.Origin);

    private static IEnumerable<FieldDiff> Flatten(IEnumerable<FieldDiff> diffs) =>
        diffs.SelectMany(d => new[] { d }.Concat(Flatten(d.Children ?? [])));

    private static IEnumerable<(string Field, string Winner, string States)> StatesOf(IEnumerable<FieldDiff> diffs) =>
        Flatten(diffs).Select(d => (d.FieldName, d.WinnerColumn, string.Join(",", d.CellStates.OrderBy(c => c.Key).Select(c => $"{c.Key}={c.Value}"))));

    [Fact]
    public void ThePluginsColumnReadsTheText_AndTheConflictStatesFollowIt()
    {
        var compare = Compare(ModPlugin, OtherChestText);

        Assert.Equal([BasePlugin, ModPlugin], compare.Overrides.Select(AddressOf));
        Assert.NotEqual(ConflictAll.NoConflict, compare.ConflictAll);
        var items = compare.Diffs.Single(d => d.FieldName == "Items");
        Assert.NotEqual(items.Values[BasePlugin.Name]?.ToString(), items.Values[ModPlugin.Name]?.ToString());
    }

    [Fact]
    public void ACopyWhosePluginIsNotActive_IsAColumnOutsideTheComparison_TheActiveCopiesClassifyAsWithoutIt()
    {
        var without = _index.Records.GetCompare(Chest.ToString()).Value() ?? throw new InvalidOperationException("Expected the record to compare.");

        var compare = Compare(InactivePlugin, OtherChestText);

        Assert.Equal([BasePlugin, ModPlugin, InactivePlugin], compare.Overrides.Select(AddressOf));
        var items = compare.Diffs.Single(d => d.FieldName == "Items");
        var ownElement = Assert.Single(items.Children ?? [], r => r.Values[InactivePlugin.Name] is not null);
        Assert.Null(ownElement.Values[BasePlugin.Name]);
        Assert.Contains("000901", ownElement.Values[InactivePlugin.Name]?.ToString(), StringComparison.Ordinal);
        Assert.All(Flatten(compare.Diffs), d => Assert.DoesNotContain(InactivePlugin.Name, d.CellStates.Keys));
        Assert.Null(compare.Overrides[^1].ConflictThis);
        Assert.Equal(without.ConflictAll, compare.ConflictAll);
        Assert.Equal(
            without.Overrides.Select(o => o.ConflictThis), compare.Overrides.Take(2).Select(o => o.ConflictThis));
        Assert.Equal(StatesOf(without.Diffs).Where(r => r.States != ""), StatesOf(compare.Diffs).Where(r => r.States != ""));
    }

    [Fact]
    public void AnOverriddenCopy_IsAColumnJustBeforeThePluginThatOverridesIt_OutsideTheComparison()
    {
        var overridden = new PluginAddress(ModPlugin.Name, "OtherMod");
        var without = _index.Records.GetCompare(Chest.ToString()).Value() ?? throw new InvalidOperationException("Expected the record to compare.");

        var compare = Compare(overridden, OtherChestText);

        Assert.Equal([BasePlugin, overridden, ModPlugin], compare.Overrides.Select(AddressOf));
        Assert.Null(compare.Overrides[1].ConflictThis);
        Assert.Equal(without.ConflictAll, compare.ConflictAll);
        Assert.All(Flatten(compare.Diffs), d => Assert.DoesNotContain(overridden.Origin, d.WinnerColumn, StringComparison.Ordinal));
        Assert.All(Flatten(compare.Diffs), d => Assert.DoesNotContain(d.CellStates.Keys, key => key.Contains(overridden.Origin, StringComparison.Ordinal)));
    }

    [Fact]
    public void AnOverriddenCopy_HasNoLoadIndex_ThePluginThatOverridesItKeepsItsOwn()
    {
        var compare = Compare(new PluginAddress(ModPlugin.Name, "OtherMod"), OtherChestText);

        Assert.Equal(["00", null, "02"], compare.Overrides.Select(o => o.LoadIndex));
    }

    [Fact]
    public void AnOverriddenCopy_WhoseOverriderHoldsNoCopy_IsAColumnWhereTheOverriderWouldBe()
    {
        var overridden = new PluginAddress(GapPlugin.Name, "OtherMod");

        var compare = Compare(overridden, OtherChestText);

        Assert.Equal([BasePlugin, overridden, ModPlugin], compare.Overrides.Select(AddressOf));
    }

    [Fact]
    public void ACopyWhosePluginIsNotActive_HasNoLoadIndex_TheActiveColumnsKeepTheirs()
    {
        var compare = Compare(InactivePlugin, OtherChestText);

        Assert.Equal(["00", "02"], compare.Overrides.Take(2).Select(o => o.LoadIndex));
        Assert.Null(compare.Overrides[^1].LoadIndex);
    }

    [Fact]
    public void ACopyComparedAlone_IsItsOwnColumnOnly_WithNoConflictState()
    {
        var compare = _index.Records.GetCompare(Chest.ToString(), new CopyText(InactivePlugin, OtherChestText, Alone: true)).Value()
            ?? throw new InvalidOperationException("Expected the record to compare.");

        Assert.Equal([InactivePlugin], compare.Overrides.Select(AddressOf));
        Assert.Null(compare.Overrides[0].ConflictThis);
        Assert.Equal(ConflictAll.NoConflict, compare.ConflictAll);
        Assert.All(Flatten(compare.Diffs), d => Assert.Empty(d.CellStates));
        Assert.Contains("000901", compare.Diffs.Single(d => d.FieldName == "Items").Children?.Single().Values[InactivePlugin.Name]?.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void TextThatIsNoRecordDocument_IsAColumnThatCouldNotBeParsed()
    {
        var compare = Compare(ModPlugin, "{ not json");

        var column = compare.Overrides.Single(o => AddressOf(o) == ModPlugin);
        Assert.False(string.IsNullOrWhiteSpace(column.ParseDiagnosis));
        Assert.All(compare.Overrides.Where(o => o != column), o => Assert.Null(o.ParseDiagnosis));
    }

    [Fact]
    public void ATextForAFormKeyNoPluginIndexes_HasNoComparison()
    {
        Assert.Null(_index.Records.GetCompare("00DEAD:Nowhere.esp", new CopyText(ModPlugin, "{}")).Value());
    }
}
