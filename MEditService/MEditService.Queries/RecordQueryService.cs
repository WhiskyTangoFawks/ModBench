using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
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
    private const int NotInLoadOrder = int.MaxValue;

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
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset, bool unfiltered = false)
    {
        var reads = RequireReads();
        var schemas = RequireSchemas();

        IReadOnlyList<string> recordTypes = types is null
            ? [.. schemas.Keys.Where(t => t != PluginHeader.RecordType)]
            : [.. types.Where(schemas.ContainsKey)];
        if (recordTypes.Count == 0)
            return new PagedResult<RecordSummary>([], 0);
        PluginName? pluginFilter = null;
        if (plugin is { } address) pluginFilter = address.Name;
        var query = new RecordQuery(
            RecordTypes: recordTypes, Plugin: pluginFilter, Origin: plugin?.Origin, Search: search,
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

    public CompareResult? GetCompare(string formKey, CopyText? text = null)
    {
        var reads = RequireReads();
        var stack = reads.GetOverrideStack(formKey);
        if (stack == null && text == null) return null;
        var snapshot = _loadOrder.Require();

        var active = stack?.Entries.Select(e => e.Effective).ToList() ?? [];
        var outside = new List<RecordDocument>();
        if (text is not null)
        {
            var at = active.FindIndex(c => PluginAddress.Comparer.Equals(c.Plugin, text.Plugin));
            var loadOrderIndex = at >= 0 ? active[at].LoadOrderIndex : snapshot.LoadOrderIndex(text.Plugin) ?? NotInLoadOrder;
            var fromText = reads.DocumentFromText(formKey, text.Plugin, loadOrderIndex, text.DocumentText);
            if (fromText is null) return null;
            if (at >= 0) active[at] = fromText with { IsWinner = active[at].IsWinner };
            else outside.Add(fromText);
        }
        var recordType = (active.Count > 0 ? active[0] : outside[0]).RecordType;

        // One memoizing cache per response (ADR-0005): a FormKey repeated across sibling
        // cells/plugins/leaves (generic fields and VMAD alike) is resolved at most once.
        var resolveFormKey = reads.LinkResolver(formKey);
        var formIds = LoadIndex.FormIdsOf(snapshot, reads.OpenedPlugins);
        var overrides = active.ConvertAll(ToRecordDetail);
        var outsideTheComparison = outside.ConvertAll(ToRecordDetail);
        var (classification, conflictAll) = ClassifyStack(overrides, resolveFormKey, formIds, outsideTheComparison);
        // PluginStates is keyed by ColumnKey.Of (ADR-0012), so a bare-plugin lookup
        // would miss for any non-Data-origin column and silently drop its ConflictThis.
        var annotated = overrides.Concat(outsideTheComparison)
            .Select(o => ToCompareOverride(
                o, classification.PluginStates.TryGetValue(ColumnKey.Of(o.Plugin, o.Origin), out var state) ? state : null,
                column: null, snapshot, reads))
            .ToList();

        return new CompareResult(annotated, classification.Diffs, conflictAll, RequireSchemas().DisplayNameFor(recordType));
    }

    public CompareResult? GetCompareRecords(IReadOnlyList<RecordCopy> copies)
    {
        var reads = RequireReads();
        var snapshot = _loadOrder.Require();

        var documents = new List<RecordDocument>(copies.Count);
        foreach (var copy in copies)
        {
            var document = copy.DocumentText is { } text
                ? reads.DocumentFromText(copy.FormKey, copy.Plugin, snapshot.LoadOrderIndex(copy.Plugin) ?? NotInLoadOrder, text)
                : reads.GetDocument(copy.FormKey, copy.Plugin);
            if (document == null) return null;
            documents.Add(document);
        }

        var records = documents.ConvertAll(ToRecordDetail);
        // Two copies may come from one plugin, so a column is named by its place as well.
        var columns = records.Select((r, i) => $"{i}#{ColumnKey.Of(r.Plugin, r.Origin)}").ToList();
        var diffs = _conflictClassifier.Align(
            records, columns, snapshot.GameRelease, reads.LinkResolver(copies[0].FormKey), LoadIndex.FormIdsOf(snapshot, reads.OpenedPlugins));
        var overrides = records.Select((r, i) => ToCompareOverride(r, state: null, columns[i], snapshot, reads)).ToList();

        return new CompareResult(overrides, diffs, ConflictAll.NoConflict, RequireSchemas().DisplayNameFor(documents[0].RecordType));
    }

    private static CompareOverride ToCompareOverride(
        RecordDetail o, ConflictThis? state, string? column, LoadOrderSnapshot snapshot, IRecordReads reads) =>
        new(o.FormKey, o.Plugin, o.LoadOrderIndex, o.IsWinner, o.EditorId, o.Fields, state,
            Origin: o.Origin,
            LoadIndex: LoadIndex.Of(new PluginAddress(o.Plugin, o.Origin), o.LoadOrderIndex, snapshot, reads.OpenedPlugins),
            RecordType: o.RecordType, IsPartialForm: o.IsPartialForm, ParseDiagnosis: o.ParseDiagnosis,
            IsInOverwrite: snapshot.ProviderOf(new PluginAddress(o.Plugin, o.Origin)) == PluginProvider.NoMod,
            Column: column);

    private (ClassifyResult Classification, ConflictAll ConflictAll) ClassifyStack(
        List<RecordDetail> committedOverrides,
        Func<string, RecordLookupEntry?> resolveFormKey,
        Func<string, uint?> loadOrderFormIds,
        List<RecordDetail> outsideTheComparison)
    {
        var release = _loadOrder.Require().GameRelease;
        // With no active copy there is nothing to compare: the copy outside it stands alone.
        var classification = committedOverrides.Count > 0
            ? _conflictClassifier.Classify(committedOverrides, release, resolveFormKey, loadOrderFormIds, outsideTheComparison)
            : new ClassifyResult(
                ConflictAll.NoConflict, new Dictionary<string, ConflictThis>(),
                _conflictClassifier.Align(
                    outsideTheComparison, [.. (outsideTheComparison).Select(r => ColumnKey.Of(r.Plugin, r.Origin))],
                    release, resolveFormKey, loadOrderFormIds));
        return (classification, classification.ConflictAll);
    }

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(PluginAddress plugin)
    {
        var reads = RequireReads();
        var schemas = RequireSchemas();
        var release = _loadOrder.Require().GameRelease;

        // The header is one `records` row per plugin, so this exclusion has to be real; without it
        // "Main File Header" appears as a browsable record-type node under every plugin.
        return [.. reads.GetRecordTypeCounts(plugin)
            .Where(c => c.Type != PluginHeader.RecordType && schemas.ContainsKey(c.Type))
            .Select(c => new PluginRecordTypeCount(
                c.Type, c.Count, schemas.DisplayNameFor(c.Type), c.HasParseFailure,
                CreatableRecordTypes.Includes(c.Type, release), ContainerChildFields.HasChildFields(c.Type, release)))
            .OrderBy(r => r.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.Type, StringComparer.Ordinal)];
    }

    public IReadOnlyList<RecordTypeChoice> GetCreatableRecordTypes()
    {
        var schemas = RequireSchemas();
        return Choices(CreatableRecordTypes.Of(schemas, _loadOrder.Require().GameRelease), schemas);
    }

    public IReadOnlyList<RecordTypeChoice>? GetChildRecordTypes(PluginAddress plugin, string formKey)
    {
        var reads = RequireReads();
        if (reads.GetDocument(formKey, plugin) is not { Body: { } body } container) return null;
        var schemas = RequireSchemas();
        var place = reads.GetCellLocation(plugin, formKey) is { } cell
            ? new CellStructure(cell.ParentWorldspace, cell.BlockX, cell.BlockY, cell.SubX, cell.SubY, cell.IsInterior).Place
            : (CellPlace?)null;
        return Choices(ChildRecordTypes.Of(container.RecordType, body, place, schemas, _loadOrder.Require().GameRelease), schemas);
    }

    // Sorted as a plugin's groups are, so the pick reads in the order the tree shows.
    private static List<RecordTypeChoice> Choices(IEnumerable<string> types, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        [.. types
            .Select(type => new RecordTypeChoice(type, schemas.DisplayNameFor(type)))
            .OrderBy(r => r.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.Type, StringComparer.Ordinal)];

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
