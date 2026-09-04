using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Core.Queries;

public sealed class RecordQueryService(
    ILoadOrderMirror loadOrder,
    SchemaReflector schemaReflector,
    ConflictClassifier conflictClassifier,
    SourceFreshness? freshness = null) : IRecordQueryService
{
    private readonly ILoadOrderMirror _mirror = loadOrder;
    private readonly SchemaReflector _schemaReflector = schemaReflector;
    private readonly ConflictClassifier _conflictClassifier = conflictClassifier;
    // GetRecord/GetCompare are where source text is re-checked against the index. Optional only so
    // read-shape tests construct this directly; the default is the real validator, never a no-op.
    private readonly SourceFreshness _freshness =
        freshness ?? new SourceFreshness(
            loadOrder, NullLogger<SourceFreshness>.Instance, new RecordTextCodec(NullLogger<RecordTextCodec>.Instance));

    public IReadOnlyList<PluginResponse> GetPlugins()
    {
        var s = RequireLoadOrder();
        // ADR-0037: one whole-load-order classification per call, and only once the load is
        // complete: a partial load order cannot tell a master not yet opened from one genuinely
        // absent, and the wrong answer is the alarming one.
        IReadOnlyDictionary<string, IReadOnlyList<MasterIssue>> masterIssues =
            _mirror.Status.State == LoadOrderState.Ready
                ? MasterResolution.Classify(s.Plugins, s.LoadFailures)
                : new Dictionary<string, IReadOnlyList<MasterIssue>>();
        PluginResponse ToResponse(PluginMetadata p, bool hasMatchingRecords) =>
            PluginResponse.FromMetadata(p, masterIssues.GetValueOrDefault(p.Name), hasMatchingRecords);

        if (s.FilterSql is null)
            return [.. s.Plugins.Select(p => ToResponse(p, hasMatchingRecords: true))];

        // ADR-0035 amending ADR-0018: a record filter prunes records and record types, never
        // a plugin row — every plugin is still returned, and HasMatchingRecords is the additive fact
        // a caller decides expandability from, not row presence.
        var matchingPlugins = RequireReads().GetPluginsWithMatchingRecords(RequireSchemas().Keys);
        return [.. s.Plugins.Select(p => ToResponse(p, matchingPlugins.Contains(p.Name)))];
    }

    // The header is not a browsable record type: it stays a schemas.Keys entry so GetRecord/
    // GetCompare resolve it by FormKey, but both browse paths below exclude it (#631).

    public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null)
    {
        var reads = RequireReads();
        var schemas = RequireSchemas();
        // The caller states which copy when it knows (a tree row does); otherwise resolve from the
        // load order, since a bare filename is all most callers have.
        origin ??= plugin == null ? null : PluginOriginResolver.Resolve(_mirror.LoadOrder, plugin);

        if (type != null && !schemas.ContainsKey(type))
            return new PagedResult<RecordSummary>([], 0);

        IReadOnlyList<string> recordTypes = type != null ? [type] : [.. schemas.Keys.Where(t => t != HeaderIndexer.RecordType)];
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
        _freshness.Validate(formKey);
        var document = RequireReads().GetDocument(formKey);
        return document == null ? null : ToRecordDetail(document);
    }

    public CompareResult? GetCompare(string formKey)
    {
        _freshness.Validate(formKey);
        var reads = RequireReads();
        // ADR-0031: one memoizing cache per response — a FormKey repeated across sibling
        // cells/plugins/leaves (generic fields and VMAD alike) is resolved at most once.
        var resolveFormKey = FormKeyResolutionCache.Memoize(reads.Resolve);

        var stack = reads.GetOverrideStack(formKey);
        if (stack == null) return null;

        var heldPlugins = RequireLoadOrder().Plugins;
        // ADR-0036: the grid is the record's in-game resolution stack, so a file-level loser is
        // not a column. Winning alone, never Participates — a disabled copy still columns.
        // Fail-open on a copy the load order lacks.
        var pluginWinning = heldPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Winning);
        var committedOverrides = stack.Entries
            .Where(e => pluginWinning.GetValueOrDefault(ColumnKey.Of(e.Plugin.Name, e.Plugin.Origin!), true))
            .Select(e => ToRecordDetail(e.Effective))
            .ToList();

        // ADR-0036: keyed by the compound column identity — with a second copy of one filename
        // loaded, a filename key is ambiguous, and ToDictionary throws outright.
        var pluginMasters = heldPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Masters);
        // ADR-0035: a non-participating plugin's override is indexed and browsable but
        // never contributes to conflict classification.
        var pluginParticipates = heldPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Participates);
        var (classification, conflictAll) =
            ClassifyStack(committedOverrides, pluginMasters, pluginParticipates, resolveFormKey);
        // ADR-0036: PluginStates is keyed by ColumnKey.Of, so a bare-plugin lookup would miss for
        // any non-Data-origin column and silently default ConflictThis to OnlyOne.
        var annotated = committedOverrides
            .ConvertAll(o => new CompareOverride(
                o.FormKey, o.Plugin, o.LoadOrderIndex, o.IsWinner, o.EditorId, o.Fields,
                classification.PluginStates.GetValueOrDefault(ColumnKey.Of(o.Plugin, o.Origin), ConflictThis.OnlyOne),
                Origin: o.Origin, RecordType: o.RecordType, IsPartialForm: o.IsPartialForm,
                IsPartialFormable: o.IsPartialFormable));

        return new CompareResult(annotated, classification.Diffs, conflictAll);
    }

    private (ClassifyResult Classification, ConflictAll ConflictAll) ClassifyStack(
        IReadOnlyList<RecordDetail> committedOverrides,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters,
        IReadOnlyDictionary<string, bool> pluginParticipates,
        Func<string, RecordLookupEntry?> resolveFormKey)
    {
        var classification = _conflictClassifier.Classify(
            committedOverrides, pluginMasters, RequireLoadOrder().GameRelease, resolveFormKey, pluginParticipates);
        return (classification, classification.ConflictAll);
    }

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null)
    {
        var reads = RequireReads();
        // Stated by the caller when it knows which copy it is browsing (a tree row does),
        // else resolved server-side from the load order.
        origin ??= PluginOriginResolver.Resolve(_mirror.LoadOrder, plugin);
        var schemas = RequireSchemas();

        // The header is one `records` row per plugin, so this exclusion has to be real; without it
        // "Main File Header" appears as a browsable record-type node under every plugin (#631).
        return [.. reads.GetRecordTypeCounts(new PluginKey(plugin, origin))
            .Where(c => c.Type != HeaderIndexer.RecordType && schemas.ContainsKey(c.Type))
            .Select(c => new PluginRecordTypeCount(c.Type, c.Count, schemas.DisplayNameFor(c.Type)))
            .OrderBy(r => r.Type)];
    }

    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) =>
        RequireReads().GetReferencedBy(targetFormKey);

    private static RecordDetail ToRecordDetail(RecordDocument document) =>
        new(document.FormKey, document.Plugin.Name, document.LoadOrderIndex, document.IsWinner, document.EditorId,
            document.Fields, Origin: document.Plugin.Origin!, RecordType: document.RecordType,
            IsPartialForm: document.IsPartialForm, IsPartialFormable: document.IsPartialFormable);

    private ILoadOrder RequireLoadOrder() => _mirror.RequireScope().LoadOrder;

    private IRecordReads RequireReads() => _mirror.RequireScope().Reads;

    private IReadOnlyDictionary<string, Schema.RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(RequireLoadOrder().GameRelease);
}
