using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Queries;

public sealed class RecordQueryService(
    IQueryIndex index,
    LoadOrderHolder loadOrder,
    SchemaReflector schemaReflector,
    ILogger<RecordQueryService>? logger = null) : IRecordQueryService
{
    private readonly IQueryIndex _index = index;
    private readonly LoadOrderHolder _loadOrder = loadOrder;
    private readonly SchemaReflector _schemaReflector = schemaReflector;
    private readonly ConflictClassifier _conflictClassifier = new ConflictClassifier(logger);

    public IReadOnlyList<PluginRow> GetPlugins()
    {
        var reads = RequireReads();
        var opened = reads.OpenedPlugins;
        // The rows and their order are the load order's; the facts reading the file yielded are the
        // Index's. A plugin the Index has not opened has none of the latter and is not a row.
        var snapshot = _loadOrder.Require();
        var rows = snapshot.Plugins.Where(c => opened.ContainsKey(c.Key)).ToList();
        var masterIssues = _index.Status.State == LoadOrderState.Ready
            ? MasterResolution.Classify(snapshot, opened)
            : null;
        var parseFailures = reads.GetPluginsWithParseFailures();
        var tracked = reads.GetTrackedPlugins();
        PluginRow ToRow(RegisteredPlugin plugin, bool hasMatchingRecords) =>
            new(plugin, snapshot.LoadOrderIndex(plugin.Key), snapshot.IsImmutable(plugin.Key), opened[plugin.Key],
                masterIssues?.GetValueOrDefault(plugin.Key, []), hasMatchingRecords,
                parseFailures.Contains(ColumnKey.Of(plugin.Name, plugin.Origin)), tracked.Contains(plugin.Key));

        if (_index.ActiveFilter is null)
            return [.. rows.Select(c => ToRow(c, hasMatchingRecords: true))];

        // plugins.md: a record filter prunes records and record types, never
        // a plugin row — every plugin is still returned, and HasMatchingRecords is the additive fact
        // a caller decides expandability from, not row presence.
        var matchingPlugins = reads.GetPluginsWithMatchingRecords(RequireSchemas().Keys);
        return [.. rows.Select(c => ToRow(c, matchingPlugins.Contains(c.Key)))];
    }

    // The header is not a browsable record type: it stays a schemas.Keys entry so GetRecord/
    // GetCompare resolve it by FormKey, but both browse paths below exclude it.

    public PagedResult<RecordSummary> GetRecords(
        IReadOnlyList<string>? types, string? plugin, string? search, int limit, int offset, string? origin = null, bool unfiltered = false)
    {
        var reads = RequireReads();
        var schemas = RequireSchemas();

        IReadOnlyList<string> recordTypes = types is null
            ? [.. schemas.Keys.Where(t => t != PluginHeader.RecordType)]
            : [.. types.Where(schemas.ContainsKey)];
        if (recordTypes.Count == 0)
            return new PagedResult<RecordSummary>([], 0);
        // ADR-0012.
        if (RecordFilterGuard.NamesOnlyPluginOrOnlyOrigin(plugin, origin))
            throw new ArgumentException("A plugin filter requires its origin, and an origin requires a plugin.");

        PluginName? pluginFilter = null;
        if (!string.IsNullOrWhiteSpace(plugin)) pluginFilter = plugin;
        var originFilter = string.IsNullOrWhiteSpace(origin) ? null : origin;
        var query = new RecordQuery(
            RecordTypes: recordTypes, Plugin: pluginFilter, Origin: originFilter, Search: search,
            SearchFormKey: FormKeyOfFormId(search, reads), Limit: limit, Offset: offset,
            GroupOnly: search is null, Unfiltered: unfiltered);
        return reads.Search(query).ToQuery();
    }

    private string? FormKeyOfFormId(string? search, IRecordReads reads) =>
        search is null ? null : LoadIndex.FormKeyOf(search, _loadOrder.Require(), reads.OpenedPlugins)?.ToString();

    public RecordDetail? GetRecord(string formKey)
    {
        var document = RequireReads().GetDocument(formKey);
        return document == null ? null : ToRecordDetail(document);
    }

    public CompareResult? GetCompare(string formKey)
    {
        var reads = RequireReads();
        // One memoizing cache per response (ADR-0005): a FormKey repeated across sibling
        // cells/plugins/leaves (generic fields and VMAD alike) is resolved at most once.
        var resolveFormKey = reads.LinkResolver(formKey);

        var stack = reads.GetOverrideStack(formKey);
        if (stack == null) return null;

        var committedOverrides = stack.Entries.Select(e => ToRecordDetail(e.Effective)).ToList();

        var snapshot = _loadOrder.Require();
        var (classification, conflictAll) = ClassifyStack(
            committedOverrides, resolveFormKey, LoadIndex.FormIdsOf(snapshot, reads.OpenedPlugins));
        // PluginStates is keyed by ColumnKey.Of (ADR-0012), so a bare-plugin lookup
        // would miss for any non-Data-origin column and silently drop its ConflictThis.
        var annotated = committedOverrides
            .ConvertAll(o => new CompareOverride(
                o.FormKey, o.Plugin, o.LoadOrderIndex, o.IsWinner, o.EditorId, o.Fields,
                classification.PluginStates.TryGetValue(ColumnKey.Of(o.Plugin, o.Origin), out var state) ? state : null,
                Origin: o.Origin,
                LoadIndex: LoadIndex.Of(new PluginAddress(o.Plugin, o.Origin), o.LoadOrderIndex, snapshot, reads.OpenedPlugins),
                RecordType: o.RecordType, IsPartialForm: o.IsPartialForm, ParseDiagnosis: o.ParseDiagnosis,
                IsInOverwrite: snapshot.ProviderOf(new PluginAddress(o.Plugin, o.Origin)) == PluginProvider.NoMod));

        return new CompareResult(
            annotated, classification.Diffs, conflictAll, RequireSchemas().DisplayNameFor(stack.RecordType));
    }

    private (ClassifyResult Classification, ConflictAll ConflictAll) ClassifyStack(
        IReadOnlyList<RecordDetail> committedOverrides,
        Func<string, RecordLookupEntry?> resolveFormKey,
        Func<string, uint?> loadOrderFormIds)
    {
        var classification = _conflictClassifier.Classify(
            committedOverrides, _loadOrder.Require().GameRelease, resolveFormKey, loadOrderFormIds);
        return (classification, classification.ConflictAll);
    }

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string origin)
    {
        var reads = RequireReads();
        var schemas = RequireSchemas();
        var release = _loadOrder.Require().GameRelease;

        // The header is one `records` row per plugin, so this exclusion has to be real; without it
        // "Main File Header" appears as a browsable record-type node under every plugin.
        return [.. reads.GetRecordTypeCounts(new PluginAddress(plugin, origin))
            .Where(c => c.Type != PluginHeader.RecordType && schemas.ContainsKey(c.Type))
            .Select(c => new PluginRecordTypeCount(
                c.Type, c.Count, schemas.DisplayNameFor(c.Type), c.HasParseFailure,
                CreatableRecordTypes.Includes(c.Type, release)))
            .OrderBy(r => r.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.Type, StringComparer.Ordinal)];
    }

    // Sorted as a plugin's groups are, so the pick reads in the order the tree shows.
    public IReadOnlyList<CreatableRecordType> GetCreatableRecordTypes()
    {
        var schemas = RequireSchemas();
        return [.. CreatableRecordTypes.Of(schemas, _loadOrder.Require().GameRelease)
            .Select(type => new CreatableRecordType(type, schemas.DisplayNameFor(type)))
            .OrderBy(r => r.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.Type, StringComparer.Ordinal)];
    }

    public bool GetLightPluginsSupported() => LightPluginSupport.Of(_loadOrder.Require().GameRelease);

    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey)
    {
        var schemas = RequireSchemas();
        var snapshot = _loadOrder.Require();
        return [.. RequireReads().GetReferencedBy(targetFormKey)
            .OrderBy(r => snapshot.LoadOrderIndex(new PluginAddress(r.Plugin, r.Origin)) ?? int.MaxValue)
            .Select(r => new ReferenceResult(
                r.FormKey, r.Plugin, r.Origin, r.FieldPath, r.RecordType, schemas.DisplayNameFor(r.RecordType), r.EditorId))];
    }

    public LoadOrderStatus GetStatus() => _index.Status;

    public long GetSequence() => _index.Sequence;

    public async Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout)
    {
        var reached = await _index.AwaitSequenceAsync(atLeast, timeout).ConfigureAwait(false);
        return new SequenceAwaitResponse(reached, _index.Sequence);
    }

    public (string Sql, string Source)? GetFilter()
    {
        RequireReads();
        return _index.ActiveFilter;
    }

    public void SetFilter(string sql, string source) => _index.SetFilter(sql, source);

    public void ClearFilter() => _index.ClearFilter();

    public string? RebuildStore(GameRelease gameRelease, string instanceRoot) =>
        _index.RebuildStore(gameRelease, instanceRoot).Refusal;

    private static RecordDetail ToRecordDetail(RecordDocument document) =>
        new(document.FormKey, document.Plugin.Name, document.LoadOrderIndex, document.IsWinner, document.EditorId,
            [.. document.Fields.Select(IndexRowMapping.ToQuery)], Origin: document.Plugin.Origin, RecordType: document.RecordType,
            IsPartialForm: document.IsPartialForm,
            ParseDiagnosis: document.ParseDiagnosis);

    private IRecordReads RequireReads() => _index.RequireReads();

    private IReadOnlyDictionary<string, RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(_loadOrder.Require().GameRelease);
}
