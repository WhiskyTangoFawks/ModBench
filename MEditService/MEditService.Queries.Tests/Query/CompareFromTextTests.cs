using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.Query;

public sealed class CompareFromTextTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress BasePlugin = new("Base.esm", "Data");
    private static readonly PluginAddress ModPlugin = new("Mod.esp", "Data");
    private static readonly PluginAddress InactivePlugin = new("Off.esp", "Data");
    private static readonly string[] Fields = ["Name", "Items", "Scale"];

    private readonly Fallout4Mod _baseMod = new(ModKey.FromFileName("Base.esm"), Fallout4Release.Fallout4);
    private readonly Fallout4Mod _modMod = new(ModKey.FromFileName("Mod.esp"), Fallout4Release.Fallout4);
    private readonly Container _chest;
    private readonly Container _editedChest;
    private readonly Container _chestOverride;
    private readonly Cell _room;
    private readonly PlacedObject _placed;
    private readonly Fallout4Mod _offMod = new(ModKey.FromFileName("Off.esp"), Fallout4Release.Fallout4);
    private readonly Cell _offRoom;
    private readonly PlacedObject _offPlaced;
    private readonly RecordQueryService _service;

    public CompareFromTextTests()
    {
        _chest = new Container(_baseMod) { EditorID = "Chest", Name = "Chest", Items = [Entry(new FormKey(_baseMod.ModKey, 0x900))] };
        _chestOverride = _modMod.Containers.GetOrAddAsOverride(_chest);
        _editedChest = new Container(_chest.FormKey, Fallout4Release.Fallout4) { EditorID = "Chest", Name = "Chest", Items = [Entry(new FormKey(_baseMod.ModKey, 0x901))] };
        _placed = new PlacedObject(_modMod) { EditorID = "Placed", Scale = 1f };
        _room = new Cell(_modMod) { EditorID = "Room" };
        _room.Temporary.Add(_placed);
        _offPlaced = new PlacedObject(_offMod) { EditorID = "OffPlaced" };
        _offRoom = new Cell(_offMod) { EditorID = "OffRoom" };
        _offRoom.Temporary.Add(_offPlaced);
        var rows = new[]
        {
            Row(_chest, BasePlugin, 0, "cont"),
            Row(_chestOverride, ModPlugin, 1, "cont"),
            Row(_room, ModPlugin, 1, "cell"),
            Row(_placed, ModPlugin, 1, "refr"),
            Row(_offRoom, InactivePlugin, 2, "cell", isWinner: false),
            Row(_offPlaced, InactivePlugin, 2, "refr", isWinner: false),
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

    private static FakeRow Row(
        IMajorRecordGetter record, PluginAddress plugin, int loadOrderIndex, string recordType, bool isWinner = true) =>
        new(plugin, loadOrderIndex, isWinner, RealDocuments.Of(record, plugin, loadOrderIndex, isWinner, Release, recordType, Fields));

    private CompareResult Compare(PluginAddress plugin, string text) =>
        _service.GetCompare(_chest.FormKey.ToString(), new CopyText(plugin, text))
        ?? throw new InvalidOperationException("Expected the record to compare.");

    private static PluginAddress AddressOf(CompareOverride column) => new(column.Plugin, column.Origin);

    private static string KeyOf(PluginAddress plugin) => ColumnKey.Of(plugin.Name, plugin.Origin);

    private static IEnumerable<FieldDiff> Flatten(IEnumerable<FieldDiff> diffs) =>
        diffs.SelectMany(d => new[] { d }.Concat(Flatten(d.Children ?? [])));

    private static IEnumerable<(string Field, string Winner, string States)> StatesOf(IEnumerable<FieldDiff> diffs) =>
        Flatten(diffs).Select(d => (d.FieldName, d.WinnerColumn, string.Join(",", d.CellStates.OrderBy(c => c.Key).Select(c => $"{c.Key}={c.Value}"))));

    [Fact]
    public void ThePluginsColumnReadsTheText_AndTheConflictStatesFollowIt()
    {
        var compare = Compare(ModPlugin, RealDocuments.BodyOf(_editedChest, Release));

        Assert.Equal([BasePlugin, ModPlugin], compare.Overrides.Select(AddressOf));
        Assert.NotEqual(ConflictAll.NoConflict, compare.ConflictAll);
        var items = compare.Diffs.Single(d => d.FieldName == "Items");
        Assert.NotEqual(items.Values[KeyOf(BasePlugin)]?.ToString(), items.Values[KeyOf(ModPlugin)]?.ToString());
    }

    [Fact]
    public void ACopyWhosePluginIsNotActive_IsAColumnOutsideTheComparison_TheActiveCopiesClassifyAsWithoutIt()
    {
        var without = _service.GetCompare(_chest.FormKey.ToString()) ?? throw new InvalidOperationException();

        var compare = Compare(InactivePlugin, RealDocuments.BodyOf(_editedChest, Release));

        Assert.Equal([BasePlugin, ModPlugin, InactivePlugin], compare.Overrides.Select(AddressOf));
        var items = compare.Diffs.Single(d => d.FieldName == "Items");
        var ownElement = Assert.Single(items.Children ?? [], r => r.Values[KeyOf(InactivePlugin)] is not null);
        Assert.Null(ownElement.Values[KeyOf(BasePlugin)]);
        Assert.Contains("000901", ownElement.Values[KeyOf(InactivePlugin)]?.ToString(), StringComparison.Ordinal);
        Assert.All(Flatten(compare.Diffs), d => Assert.DoesNotContain(KeyOf(InactivePlugin), d.CellStates.Keys));
        Assert.Null(compare.Overrides[^1].ConflictThis);
        Assert.Equal(without.ConflictAll, compare.ConflictAll);
        Assert.Equal(
            without.Overrides.Select(o => o.ConflictThis), compare.Overrides.Take(2).Select(o => o.ConflictThis));
        Assert.Equal(StatesOf(without.Diffs).Where(r => r.States != ""), StatesOf(compare.Diffs).Where(r => r.States != ""));
    }

    [Fact]
    public void AChildsColumn_IsReadFromItsContainersText()
    {
        _placed.EditorID = "Edited";
        _placed.Scale = 2.5f;
        var cellText = RealDocuments.BodyOf(_room, Release);

        var compare = _service.GetCompare(_placed.FormKey.ToString(), new CopyText(ModPlugin, cellText))
            ?? throw new InvalidOperationException("Expected the child to compare.");

        var column = compare.Overrides.Single();
        Assert.Equal(("Edited", null), (column.EditorId, column.ParseDiagnosis));
        Assert.Equal("2.5", compare.Diffs.Single(d => d.FieldName == "Scale").Values[KeyOf(ModPlugin)]?.ToString());
    }

    [Fact]
    public void AChildsColumn_IsReadFromItsContainersText_WhenNeitherIsInAnActivePlugin()
    {
        _offPlaced.EditorID = "Edited";

        var compare = _service.GetCompare(_offPlaced.FormKey.ToString(), new CopyText(InactivePlugin, RealDocuments.BodyOf(_offRoom, Release)))
            ?? throw new InvalidOperationException("Expected the child to compare.");

        var column = compare.Overrides.Single();
        Assert.Equal(("Edited", null), (column.EditorId, column.ParseDiagnosis));
    }

    [Fact]
    public void AContainersTextThatNoLongerCarriesTheChild_IsAColumnSayingSo()
    {
        _room.Temporary.Clear();
        var cellText = RealDocuments.BodyOf(_room, Release);

        var compare = _service.GetCompare(_placed.FormKey.ToString(), new CopyText(ModPlugin, cellText))
            ?? throw new InvalidOperationException("Expected the child to compare.");

        var column = compare.Overrides.Single();
        Assert.Equal((_placed.FormKey.ToString(), (string?)null), (column.FormKey, column.EditorId));
        Assert.Contains(_room.FormKey.ToString(), column.ParseDiagnosis, StringComparison.Ordinal);
        Assert.Contains(_placed.FormKey.ToString(), column.ParseDiagnosis, StringComparison.Ordinal);
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
        Assert.Null(_service.GetCompare("00DEAD:Nowhere.esp", new CopyText(ModPlugin, "{}")));
    }
}
