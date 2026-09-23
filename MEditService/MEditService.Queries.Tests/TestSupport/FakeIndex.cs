using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;

namespace MEditService.Queries.Tests.TestSupport;

/// <summary>One plugin's committed copy of one record, the unit <see cref="FakeReads"/> is built
/// from — carrying only the documents a test needs, never a whole plugin's worth.</summary>
internal sealed record FakeRow(PluginCopyKey Plugin, int LoadOrderIndex, bool IsWinner, RecordDocument Document);

/// <summary>The Index doors Queries drives, hand-built from <see cref="FakeRow"/> entries instead of
/// a real DuckDB store.</summary>
internal sealed class FakeReads(
    IReadOnlyDictionary<PluginCopyKey, PluginContent> openedCopies, IReadOnlyList<FakeRow> rows) : IRecordReads
{
    public IReadOnlySet<PluginCopyKey> MatchingPlugins { get; set; } = new HashSet<PluginCopyKey>(PluginCopyKey.Comparer);

    public IReadOnlyDictionary<string, IReadOnlyList<ReferenceResult>> ReferencedBy { get; set; } =
        new Dictionary<string, IReadOnlyList<ReferenceResult>>(StringComparer.Ordinal);

    public IReadOnlyDictionary<PluginCopyKey, PluginContent> OpenedCopies => openedCopies;

    public RecordDocument? GetDocument(string formKey) =>
        rows.FirstOrDefault(r => r.Document.FormKey == formKey && r.IsWinner)?.Document;

    public RecordDocument? GetDocument(string formKey, PluginCopyKey plugin) =>
        rows.FirstOrDefault(r => r.Document.FormKey == formKey && r.Plugin.Equals(plugin))?.Document;

    public IReadOnlyList<RecordDocument> GetDocuments(PluginCopyKey plugin) =>
        [.. rows.Where(r => r.Plugin.Equals(plugin)).Select(r => r.Document)];

    public RecordOverrides? GetOverrideStack(string formKey)
    {
        var entries = rows.Where(r => r.Document.FormKey == formKey)
            .OrderBy(r => r.LoadOrderIndex)
            .Select(r => new OverrideStackEntry(r.Plugin, r.LoadOrderIndex, r.IsWinner, r.Document, r.Document, HasWorkingTreeChange: false))
            .ToList();
        return entries.Count == 0 ? null : new RecordOverrides(formKey, entries[0].Effective.RecordType, entries);
    }

    // Matching, sorting and paging are the real Index's own behaviour (RecordReadsTests), not
    // Queries'. This answers with exactly what the test configured, recording the query asked of it
    // so a test can assert on the RecordQuery RecordQueryService built.
    public RecordQuery? LastSearch { get; private set; }
    public PagedResult<RecordSummary> SearchResult { get; set; } = new([], 0);

    public PagedResult<RecordSummary> Search(RecordQuery query)
    {
        LastSearch = query;
        return SearchResult;
    }

    // The grouping and counting are the real Index's own behaviour too; keyed so a test can
    // configure one plugin's counts without touching another's.
    public IReadOnlyDictionary<PluginCopyKey, IReadOnlyList<RecordTypeCount>> RecordTypeCountsByPlugin { get; set; } =
        new Dictionary<PluginCopyKey, IReadOnlyList<RecordTypeCount>>();

    public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginCopyKey plugin) =>
        RecordTypeCountsByPlugin.GetValueOrDefault(plugin, []);

    public RecordLookupEntry? Resolve(string formKey) =>
        rows.FirstOrDefault(r => r.Document.FormKey == formKey && r.IsWinner) is { Document: { } d } ? new(d.RecordType, d.EditorId) : null;

    public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) =>
        ReferencedBy.GetValueOrDefault(targetFormKey, []);

    public IReadOnlySet<PluginCopyKey> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) => MatchingPlugins;

    public IReadOnlySet<string> GetPluginsWithParseFailures() =>
        rows.Where(r => r.Document.ParseDiagnosis != null).Select(r => ColumnKey.Of(r.Plugin.Name, r.Plugin.Origin))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    // Projecting a diagnosis and deciding which copies were derived from a source tree are the real
    // Index's own behaviour; a test states the rows it wants read back.
    public IReadOnlyList<PluginDiagnosisRow> Diagnoses { get; set; } = [];

    public IReadOnlySet<PluginCopyKey> Tracked { get; set; } = new HashSet<PluginCopyKey>(PluginCopyKey.Comparer);

    public IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses() => Diagnoses;
    public IReadOnlySet<PluginCopyKey> GetTrackedCopies() => Tracked;
    public IReadOnlySet<string> GetWorldspacesWithFailuresBelow(PluginCopyKey plugin) => new HashSet<string>();
    public IReadOnlyList<string> GetNativeFormKeys(PluginCopyKey plugin) => [];
    public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginCopyKey plugin, string worldspaceFormKey) => [];
    public PagedResult<CellSummary> GetInteriorCells(PluginCopyKey plugin, int limit, int offset) => new([], 0);
    public CellReferences GetCellReferences(PluginCopyKey plugin, string cellFormKey) => new([], []);
    public PlacementRow? GetPlacement(string formKey, PluginCopyKey plugin) => null;
    public CellLocationRow? GetCellLocation(PluginCopyKey plugin, string cellFormKey) => null;
    public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginCopyKey plugin, string parentFormKey) => [];
    public ContainerChildRow? GetContainerParent(PluginCopyKey plugin, string childFormKey) => null;
}

/// <summary>The IQueryIndex door over a FakeReads: a settable status and filter, since a hand
/// double states what it needs rather than computing it.</summary>
internal sealed class FakeIndex(FakeReads reads, LoadOrderStatus? status = null) : IQueryIndex
{
    public LoadOrderStatus Status { get; set; } = status ?? new LoadOrderStatus(LoadOrderState.Ready, reads.OpenedCopies.Count, [], true, []);
    public string? FilterSql { get; set; }
    public IRecordReads RequireReads() => reads;

    // Mirrors IndexProjector's own SetFilter/ClearFilter shape; a hand double states the filter
    // directly rather than compiling SQL to evaluate it.
    internal void SetFilter(string sql) => FilterSql = sql;
    internal void ClearFilter() => FilterSql = null;

    /// <summary>A whole fixture, opened: the index and the load order it was built against.</summary>
    internal static (FakeIndex Index, LoadOrderHolder Holder) From(FakeFixtureData fixture)
    {
        var holder = FakeLoadOrder.Of(fixture.Release, [.. fixture.Copies]);
        return (new FakeIndex(new FakeReads(fixture.OpenedCopies, fixture.Rows)), holder);
    }
}
