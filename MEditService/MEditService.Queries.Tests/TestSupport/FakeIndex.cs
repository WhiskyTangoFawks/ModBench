using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.TestSupport;

/// <summary>One plugin's committed copy of one record, the unit <see cref="FakeReads"/> is built
/// from — carrying only the documents a test needs, never a whole plugin's worth.</summary>
internal sealed record FakeRow(PluginCopyKey Plugin, int LoadOrderIndex, bool IsWinner, RecordDocument Document);

/// <summary>The Index doors Queries drives, hand-built from <see cref="FakeRow"/> entries instead of
/// a real DuckDB store.</summary>
internal sealed class FakeReads(
    IReadOnlyDictionary<PluginCopyKey, PluginContent> openedCopies, IReadOnlyList<FakeRow> rows) : IRecordReads
{
    public IReadOnlySet<string> MatchingPlugins { get; set; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

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

    public PagedResult<RecordSummary> Search(RecordQuery query)
    {
        IEnumerable<FakeRow> filtered = rows;
        if (query.RecordTypes is { Count: > 0 })
        {
            var types = new HashSet<string>(query.RecordTypes, StringComparer.OrdinalIgnoreCase);
            filtered = filtered.Where(r => types.Contains(r.Document.RecordType));
        }
        if (query.Plugin is { } plugin)
            filtered = filtered.Where(r => string.Equals(r.Plugin.Name, plugin.Name, StringComparison.OrdinalIgnoreCase));
        if (query.Origin is { } origin)
            filtered = filtered.Where(r => string.Equals(r.Plugin.Origin, origin, StringComparison.OrdinalIgnoreCase));
        if (query.Search is { } search)
            filtered = FormKey.TryFactory(search, out var formKey)
                ? filtered.Where(r => string.Equals(r.Document.FormKey, formKey.ToString(), StringComparison.OrdinalIgnoreCase))
                : filtered.Where(r => r.Document.EditorId?.Contains(search, StringComparison.OrdinalIgnoreCase) == true);

        var ordered = filtered
            .OrderBy(r => r.Document.EditorId, StringComparer.Ordinal)
            .ThenBy(r => r.Document.FormKey, StringComparer.Ordinal)
            .ThenBy(r => r.Plugin.Name, StringComparer.Ordinal)
            .ThenBy(r => r.Plugin.Origin, StringComparer.Ordinal)
            .ToList();
        var page = ordered.Skip(query.Offset).Take(query.Limit)
            .Select(r => new RecordSummary(
                r.Document.FormKey, r.Plugin.Name, r.LoadOrderIndex, r.IsWinner, r.Document.EditorId, r.Plugin.Origin,
                ParseDiagnosis: r.Document.ParseDiagnosis, HasParseFailure: r.Document.ParseDiagnosis != null))
            .ToList();
        return new(page, ordered.Count);
    }

    public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginCopyKey plugin) =>
        [.. rows.Where(r => r.Plugin.Equals(plugin))
            .GroupBy(r => r.Document.RecordType)
            .Select(g => new RecordTypeCount(g.Key, g.Count(), g.Any(r => r.Document.ParseDiagnosis != null)))];

    public RecordLookupEntry? Resolve(string formKey) =>
        rows.FirstOrDefault(r => r.Document.FormKey == formKey && r.IsWinner) is { Document: { } d } ? new(d.RecordType, d.EditorId) : null;

    public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) =>
        ReferencedBy.GetValueOrDefault(targetFormKey, []);

    public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) => MatchingPlugins;

    public IReadOnlySet<string> GetPluginsWithParseFailures() =>
        rows.Where(r => r.Document.ParseDiagnosis != null).Select(r => ColumnKey.Of(r.Plugin.Name, r.Plugin.Origin))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

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
