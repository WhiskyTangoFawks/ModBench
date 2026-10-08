using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.RealData;

[Collection(CutDownPluginCollection.Name)]
public sealed class RealDataReadGoldenTests(CutDownPluginFixture fixture)
{
    private readonly IRecordReads _repo = fixture.Reads;
    private const string Origin = PluginOrigin.DataDirectory;
    private const int PerType = 3;
    private const int WholeType = 5000;

    private static readonly string[] Types =
        ["achr", "acti", "armo", "cell", "dial", "dlbr", "fact", "glob", "info", "kywd", "misc", "npc_", "qust", "race", "refr", "scen", "weap", "wrld"];

    private static object Project(RecordDocument d) => new
    {
        d.FormKey,
        Plugin = d.Plugin.Name,
        Origin = d.Plugin.Origin,
        d.LoadOrderIndex,
        d.IsWinner,
        d.EditorId,
        d.RecordType,
        Fields = d.Fields.ToDictionary(f => f.Metadata.Name, f => f.Value),
        CheckErrors = d.Fields.Where(f => f.CheckError != null).ToDictionary(f => f.Metadata.Name, f => f.CheckError),
    };

    private IReadOnlyList<string> LowestFormKeysOf(string type)
    {
        var page = _repo.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: [type], Limit: WholeType, Offset: 0));
        Assert.True(page.Total <= WholeType, $"'{type}' has {page.Total} records, more than the {WholeType} one page lists.");
        return [.. page.Items.Select(r => r.FormKey).Order(StringComparer.Ordinal).Take(PerType)];
    }

    private object WholeListing(string type)
    {
        var page = _repo.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: [type], Plugin: TestPluginName, Origin: Origin, Limit: WholeType, Offset: 0));
        Assert.True(page.Total <= WholeType, $"'{type}' has {page.Total} records, more than the {WholeType} one page lists.");
        return new
        {
            page.Total,
            Sample = page.Items.OrderBy(r => r.FormKey, StringComparer.Ordinal).Take(10).ToList(),
        };
    }

    [Fact]
    public void RecordDetail_ForEveryRecordType_MatchesGolden()
    {
        var captured = Types.ToDictionary(
            type => type,
            type => LowestFormKeysOf(type)
                .SelectMany(fk => _repo.GetDocument(fk, new PluginAddress(TestPluginName, Origin))
                    is not { } document ? [] : new[] { Project(document) })
                .ToList());

        Golden.Verify("realdata-record-detail", captured);
    }

    [Fact]
    public void Listings_AndCounts_MatchGolden()
    {
        var captured = new
        {
            Counts = Types.ToDictionary(t => t, t => _repo.GetRecordTypeCounts(new PluginAddress(TestPluginName, Origin))
                .FirstOrDefault(c => string.Equals(c.Type, t, StringComparison.OrdinalIgnoreCase))?.Count ?? 0),
            Listings = Types.ToDictionary(t => t, WholeListing),
            SearchAllTypesTotal = _repo.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: [.. Types], Plugin: TestPluginName, Origin: Origin, Limit: WholeType, Offset: 0)).Total,
            SearchByEditorId = _repo.Search(new RecordQuery(RecordQueryScope.Search, RecordTypes: [.. Types], Plugin: TestPluginName, Origin: Origin, Search: "Workshop", Limit: WholeType, Offset: 0))
                .Items.OrderBy(r => r.FormKey, StringComparer.Ordinal).Take(20).ToList(),
        };

        Golden.Verify("realdata-listings", captured);
    }

    [Fact]
    public void SpatialReads_MatchGolden()
    {
        var worldspaces = LowestFormKeysOf("wrld");
        var cells = LowestFormKeysOf("cell");
        var captured = new
        {
            WorldspaceCells = worldspaces.ToDictionary(
                fk => fk, fk => _repo.GetWorldspaceCells(new PluginAddress(TestPluginName, Origin), fk)
                    .OrderBy(c => c.FormKey, StringComparer.Ordinal).ToList()),
            InteriorCells = _repo.GetInteriorCells(new PluginAddress(TestPluginName, Origin))
                .OrderBy(c => c.FormKey, StringComparer.Ordinal).ToList(),
            CellChildRecords = cells.ToDictionary(
                fk => fk, fk =>
                {
                    var refs = _repo.GetCellChildRecords(new PluginAddress(TestPluginName, Origin), fk);
                    return new
                    {
                        Persistent = refs.Persistent.OrderBy(r => r.FormKey, StringComparer.Ordinal).ToList(),
                        Temporary = refs.Temporary.OrderBy(r => r.FormKey, StringComparer.Ordinal).ToList(),
                    };
                }),
        };

        Golden.Verify("realdata-spatial", captured);
    }

    [Fact]
    public void ReferencesAndResolution_MatchGolden()
    {
        var allFormKeys = Types.SelectMany(LowestFormKeysOf).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
        var captured = new
        {
            ReferencedBy = allFormKeys
                .Select(fk => (FormKey: fk, Refs: _repo.GetReferencedBy(fk)))
                .Where(r => r.Refs.Count > 0)
                .ToDictionary(r => r.FormKey, r => new
                {
                    Count = r.Refs.Count,
                    Sample = r.Refs
                        .OrderBy(x => x.FormKey, StringComparer.Ordinal)
                        .ThenBy(x => x.FieldPath, StringComparer.Ordinal)
                        .Take(5).ToList(),
                }),
            Resolved = allFormKeys.ToDictionary(fk => fk, _repo.Resolve),
        };

        Assert.NotEmpty(captured.ReferencedBy);
        Golden.Verify("realdata-references", captured);
    }

    private const string TestPluginName = RealDataPlugin.PluginFileName;
}
