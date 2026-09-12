using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using Mutagen.Bethesda;

namespace MEditService.Queries;

public sealed class RecordQueryService(
    IQueryIndex index,
    LoadOrderHolder loadOrder,
    SchemaReflector schemaReflector,
    ConflictClassifier conflictClassifier) : IRecordQueryService
{
    private readonly IQueryIndex _index = index;
    private readonly LoadOrderHolder _loadOrder = loadOrder;
    private readonly SchemaReflector _schemaReflector = schemaReflector;
    private readonly ConflictClassifier _conflictClassifier = conflictClassifier;

    public IReadOnlyList<PluginRow> GetPlugins()
    {
        var reads = RequireReads();
        var opened = reads.OpenedCopies;
        // The rows and their order are the load order's; the facts reading the file yielded are the
        // Index's. A copy the Index has not opened has none of the latter and is not a row.
        var rows = _loadOrder.Require().Copies.Where(c => opened.ContainsKey(c.Key)).ToList();
        // ADR-0012: classified once per call, and only once the projection is complete: a partial
        // load order cannot tell a master not yet opened from one genuinely absent. Reconciling
        // reports no issues rather than inventing a third state.
        var status = _index.Status;
        IReadOnlyDictionary<string, IReadOnlyList<MasterIssue>> masterIssues =
            status.State == LoadOrderState.Ready
                ? MasterResolution.Classify(opened, status.Failures)
                : new Dictionary<string, IReadOnlyList<MasterIssue>>();
        var parseFailures = reads.GetPluginsWithParseFailures();
        PluginRow ToRow(RegisteredCopy copy, bool hasMatchingRecords) =>
            new(copy, opened[copy.Key], masterIssues.GetValueOrDefault(copy.Name) ?? [], hasMatchingRecords,
                parseFailures.Contains(ColumnKey.Of(copy.Name, copy.Origin)));

        if (_index.FilterSql is null)
            return [.. rows.Select(c => ToRow(c, hasMatchingRecords: true))];

        // plugins.md: a record filter prunes records and record types, never
        // a plugin row — every plugin is still returned, and HasMatchingRecords is the additive fact
        // a caller decides expandability from, not row presence.
        var matchingPlugins = reads.GetPluginsWithMatchingRecords(RequireSchemas().Keys);
        return [.. rows.Select(c => ToRow(c, matchingPlugins.Contains(c.Name)))];
    }

    // The header is not a browsable record type: it stays a schemas.Keys entry so GetRecord/
    // GetCompare resolve it by FormKey, but both browse paths below exclude it.

    public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null)
    {
        var reads = RequireReads();
        var schemas = RequireSchemas();
        // The caller states which copy when it knows (a tree row does); otherwise resolve from the
        // load order, since a bare filename is all most callers have.
        origin ??= plugin == null ? null : PluginOriginResolver.Resolve(_loadOrder.Require(), plugin);

        if (type != null && !schemas.ContainsKey(type))
            return new PagedResult<RecordSummary>([], 0);

        IReadOnlyList<string> recordTypes = type != null ? [type] : [.. schemas.Keys.Where(t => t != PluginHeader.RecordType)];
        // Written as an if rather than `plugin == null ? null : new PluginKey(plugin, origin)`
        // — PluginKey's implicit string conversion makes that ternary's common-type inference reach
        // for the null literal via `string`, tripping CS8625 on PluginKey.Name.
        PluginKey? pluginKey = null;
        if (plugin != null) pluginKey = new PluginKey(plugin, origin);
        var query = new RecordQuery(RecordTypes: recordTypes, Plugin: pluginKey, Search: search, Limit: limit, Offset: offset);
        return reads.Search(query);
    }

    public RecordDetail? GetRecord(string formKey)
    {
        var document = RequireReads().GetDocument(formKey);
        return document == null ? null : ToRecordDetail(document);
    }

    public CompareResult? GetCompare(string formKey)
    {
        var reads = RequireReads();
        // ADR-0005: one memoizing cache per response — a FormKey repeated across sibling
        // cells/plugins/leaves (generic fields and VMAD alike) is resolved at most once.
        var resolveFormKey = FormKeyResolutionCache.Memoize(reads.Resolve);

        var stack = reads.GetOverrideStack(formKey);
        if (stack == null) return null;

        var copies = _loadOrder.Require().Copies;
        // ADR-0012: the grid is the record's in-game resolution stack, so a file-level loser is
        // not a column. Winning alone, never Participates — a disabled copy still columns.
        // Fail-open on a copy the load order lacks.
        var pluginWinning = copies.ToDictionary(c => ColumnKey.Of(c.Name, c.Origin), c => c.Winning);
        var committedOverrides = stack.Entries
            .Where(e => pluginWinning.GetValueOrDefault(ColumnKey.Of(e.Plugin.Name, e.Plugin.Origin!), true))
            .Select(e => ToRecordDetail(e.Effective))
            .ToList();

        // ADR-0012: keyed by the compound column identity — with a second copy of one filename
        // loaded, a filename key is ambiguous, and ToDictionary throws outright.
        var pluginMasters = reads.OpenedCopies.ToDictionary(
            kv => ColumnKey.Of(kv.Key.Name, kv.Key.Origin!), kv => kv.Value.Masters);
        // ADR-0013: a non-participating plugin's override is indexed and browsable but
        // never contributes to conflict classification.
        var pluginParticipates = copies.ToDictionary(
            c => ColumnKey.Of(c.Name, c.Origin), c => c.Registration.Participates);
        var (classification, conflictAll) =
            ClassifyStack(committedOverrides, pluginMasters, pluginParticipates, resolveFormKey);
        // ADR-0012: PluginStates is keyed by ColumnKey.Of, so a bare-plugin lookup would miss for
        // any non-Data-origin column and silently default ConflictThis to OnlyOne.
        var annotated = committedOverrides
            .ConvertAll(o => new CompareOverride(
                o.FormKey, o.Plugin, o.LoadOrderIndex, o.IsWinner, o.EditorId, o.Fields,
                classification.PluginStates.GetValueOrDefault(ColumnKey.Of(o.Plugin, o.Origin), ConflictThis.OnlyOne),
                Origin: o.Origin, RecordType: o.RecordType, IsPartialForm: o.IsPartialForm,
                IsPartialFormable: o.IsPartialFormable, ParseDiagnosis: o.ParseDiagnosis));

        return new CompareResult(annotated, classification.Diffs, conflictAll);
    }

    private (ClassifyResult Classification, ConflictAll ConflictAll) ClassifyStack(
        IReadOnlyList<RecordDetail> committedOverrides,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters,
        IReadOnlyDictionary<string, bool> pluginParticipates,
        Func<string, RecordLookupEntry?> resolveFormKey)
    {
        var classification = _conflictClassifier.Classify(
            committedOverrides, pluginMasters, _loadOrder.Require().GameRelease, resolveFormKey, pluginParticipates);
        return (classification, classification.ConflictAll);
    }

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null)
    {
        var reads = RequireReads();
        // Stated by the caller when it knows which copy it is browsing (a tree row does),
        // else resolved server-side from the load order.
        origin ??= PluginOriginResolver.Resolve(_loadOrder.Require(), plugin);
        var schemas = RequireSchemas();

        // The header is one `records` row per plugin, so this exclusion has to be real; without it
        // "Main File Header" appears as a browsable record-type node under every plugin.
        return [.. reads.GetRecordTypeCounts(new PluginKey(plugin, origin))
            .Where(c => c.Type != PluginHeader.RecordType && schemas.ContainsKey(c.Type))
            .Select(c => new PluginRecordTypeCount(c.Type, c.Count, schemas.DisplayNameFor(c.Type), c.HasParseFailure))
            .OrderBy(r => r.Type)];
    }

    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) =>
        RequireReads().GetReferencedBy(targetFormKey);

    private static RecordDetail ToRecordDetail(RecordDocument document) =>
        new(document.FormKey, document.Plugin.Name, document.LoadOrderIndex, document.IsWinner, document.EditorId,
            document.Fields, Origin: document.Plugin.Origin!, RecordType: document.RecordType,
            IsPartialForm: document.IsPartialForm, IsPartialFormable: document.IsPartialFormable,
            ParseDiagnosis: document.ParseDiagnosis);

    private IRecordReads RequireReads() => _index.RequireReads();

    private IReadOnlyDictionary<string, RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(_loadOrder.Require().GameRelease);
}
