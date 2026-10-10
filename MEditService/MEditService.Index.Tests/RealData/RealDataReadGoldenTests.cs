using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.RealData;

[Collection(CutDownPluginCollection.Name)]
public sealed class RealDataReadGoldenTests(CutDownPluginFixture fixture)
{
    private readonly OpenedIndex _index = fixture.Index;
    private const int PerType = 3;
    private const int WholeType = 5000;

    private static readonly string[] Types =
        ["achr", "acti", "armo", "cell", "dial", "dlbr", "fact", "glob", "info", "kywd", "misc", "npc_", "qust", "race", "refr", "scen", "weap", "wrld"];

    private static object Project(RecordDetail d) => new
    {
        d.FormKey,
        d.Plugin,
        d.Origin,
        d.LoadOrderIndex,
        d.IsWinner,
        d.EditorId,
        d.RecordType,
        Fields = d.Fields.ToDictionary(f => f.Metadata.Name, f => f.Value),
        CheckErrors = d.Fields.Where(f => f.CheckError != null).ToDictionary(f => f.Metadata.Name, f => f.CheckError),
    };

    private IReadOnlyList<string> LowestFormKeysOfTheRelationHoldingHeldRecordsToo(string type) =>
        [.. IndexFiles.Rows(fixture.InstanceRoot, $"SELECT form_key FROM records WHERE record_type = '{type}'")
            .Select(row => row[0]).Order(StringComparer.Ordinal).Take(PerType)];

    private PagedResult<RecordSummary> Listing(IReadOnlyList<string> types, string? search)
    {
        var page = _index.Queries.GetRecords(types, CutDownPluginFixture.Plugin, search, WholeType, offset: 0).Value();
        Assert.True(page.Total <= WholeType, $"'{string.Join(", ", types)}' has {page.Total} records, more than the {WholeType} one page lists.");
        return page;
    }

    private object WholeListing(string type)
    {
        var page = Listing([type], search: null);
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
            type => LowestFormKeysOfTheRelationHoldingHeldRecordsToo(type)
                .SelectMany(fk => _index.CopyIn(fk, CutDownPluginFixture.Plugin) is not { } document ? [] : new[] { Project(document) })
                .ToList());

        Golden.Verify("realdata-record-detail", captured);
    }

    [Fact]
    public void Listings_AndCounts_MatchGolden()
    {
        var captured = new
        {
            Counts = Types.ToDictionary(t => t, t => _index.CountOf(CutDownPluginFixture.Plugin, t)),
            Listings = Types.ToDictionary(t => t, WholeListing),
            SearchAllTypesTotal = Listing(Types, search: null).Total,
            SearchByEditorId = Listing(Types, "Workshop").Items.OrderBy(r => r.FormKey, StringComparer.Ordinal).Take(20).ToList(),
        };

        Golden.Verify("realdata-listings", captured);
    }

    [Fact]
    public void SpatialReads_MatchGolden()
    {
        var captured = new
        {
            WorldspaceBlocks = LowestFormKeysOfTheRelationHoldingHeldRecordsToo("wrld").ToDictionary(
                fk => fk, fk => _index.Queries.GetWorldspaceBlocks(CutDownPluginFixture.Plugin, fk).Value()),
            InteriorCells = _index.Queries.GetInteriorCells(CutDownPluginFixture.Plugin).Value(),
            CellChildRecords = LowestFormKeysOfTheRelationHoldingHeldRecordsToo("cell").ToDictionary(
                fk => fk, fk =>
                {
                    var refs = _index.Queries.GetCellChildRecords(CutDownPluginFixture.Plugin, fk).Value();
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
        var allFormKeys = Types.SelectMany(LowestFormKeysOfTheRelationHoldingHeldRecordsToo)
            .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
        var linkingNpc = LowestFormKeysOfTheRelationHoldingHeldRecordsToo("npc_")[0];
        var captured = new
        {
            ReferencedBy = allFormKeys
                .Select(fk => (FormKey: fk, Refs: _index.Queries.GetReferences(fk).Value()))
                .Where(r => r.Refs.Count > 0)
                .ToDictionary(r => r.FormKey, r => new
                {
                    Count = r.Refs.Count,
                    Sample = r.Refs
                        .OrderBy(x => x.FormKey, StringComparer.Ordinal)
                        .ThenBy(x => x.FieldPath, StringComparer.Ordinal)
                        .Take(5).ToList(),
                }),
            Resolved = allFormKeys.ToDictionary(fk => fk, fk => _index.ResolutionOf(linkingNpc, CutDownPluginFixture.Plugin, fk)),
        };

        Assert.NotEmpty(captured.ReferencedBy);
        Golden.Verify("realdata-references", captured);
    }
}
