using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Core.Queries;

public sealed class RecordQueryService(
    ISessionManager session,
    ISchemaReflector schemaReflector,
    IConflictClassifier conflictClassifier,
    ILogger<RecordQueryService>? logger = null) : IRecordQueryService
{
    private readonly ISessionManager _session = session;
    private readonly ISchemaReflector _schemaReflector = schemaReflector;
    private readonly IConflictClassifier _conflictClassifier = conflictClassifier;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    public IReadOnlyList<PluginResponse> GetPlugins()
    {
        var s = RequireSession();
        // #277 / ADR-0037: one whole-session classification per call, not per plugin — Classify
        // is already a single pass over every plugin's Masters list.
        //
        // #274: only once the load is complete. Classify answers "is this master anywhere in the
        // session", which a partial session cannot answer — a master that is present on disk and
        // merely not opened yet is indistinguishable from one that is genuinely absent, and the
        // wrong answer is the alarming one. Reported as "no issues" while loading rather than as a
        // separate not-yet-computed value: the caller already knows the load is running (it is in
        // the same status), and inventing a third state here would put that knowledge in two places.
        IReadOnlyDictionary<string, IReadOnlyList<MasterIssue>> masterIssues =
            _session.Status.State == SessionState.Ready
                ? MasterResolution.Classify(s.Plugins, s.LoadFailures)
                : new Dictionary<string, IReadOnlyList<MasterIssue>>();
        PluginResponse ToResponse(PluginMetadata p, bool hasMatchingRecords) =>
            PluginResponse.FromMetadata(p, masterIssues.GetValueOrDefault(p.Name), hasMatchingRecords);

        if (s.FilterSql is null)
            return [.. s.Plugins.Select(p => ToResponse(p, hasMatchingRecords: true))];

        // #278 / ADR-0035 amending ADR-0018: a record filter prunes records and record types, never
        // a plugin row — every plugin is still returned, and HasMatchingRecords is the additive fact
        // a caller (the composite's chevron) decides expandability from, not row presence.
        var matchingPlugins = RequireRepository().GetPluginsWithMatchingRecords(RequireSchemas().Keys);
        return [.. s.Plugins.Select(p => ToResponse(p, matchingPlugins.Contains(p.Name)))];
    }

    // The header isn't a browsable record type (User Story 7's "expand a plugin -> record types"
    // listing, or an unscoped "all types" search) — it's reached only via "Open Header" on the
    // plugin node. It stays a real schemas.Keys entry so GetRecord/GetCompare (a direct FormKey
    // lookup) can still resolve it; only these two browse-all-types paths exclude it.
    private const string HeaderTableName = "header";

    public IReadOnlyList<string> GetRecordTypes() =>
        [.. RequireSchemas().Keys.Where(t => t != HeaderTableName).Order()];

    public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null)
    {
        var repository = RequireRepository();
        var schemas = RequireSchemas();
        // #34: the caller states which copy when it knows (a tree row does; it was built from one).
        // Otherwise the #296 behaviour stands — resolve server-side from the load order, since a
        // bare filename is all most callers have. Null when plugin itself is null (nothing to resolve).
        origin ??= plugin == null ? null : PluginOriginResolver.Resolve(_session.Session, plugin);

        if (type != null && !schemas.ContainsKey(type))
            return new PagedResult<RecordSummary>([], 0);

        IReadOnlyList<string> recordTypes = type != null ? [type] : [.. schemas.Keys.Where(t => t != HeaderTableName)];
        // #421: written as an if rather than `plugin == null ? null : new PluginKey(plugin, origin)`
        // — PluginKey's implicit string conversion makes that ternary's common-type inference reach
        // for the null literal via `string`, tripping CS8625 on PluginKey.Name.
        PluginKey? pluginKey = null;
        if (plugin != null) pluginKey = new PluginKey(plugin, origin);
        var query = new RecordQuery(RecordTypes: recordTypes, Plugin: pluginKey, Search: search, Limit: limit, Offset: offset);
        return repository.Search(query);
    }

    public RecordDetail? GetRecord(string formKey)
    {
        var document = RequireRepository().GetDocument(formKey);
        return document == null ? null : ToRecordDetail(document);
    }

    public CompareResult? GetCompare(string formKey)
    {
        var repository = RequireRepository();
        // ADR-0031: one memoizing cache per response — a FormKey repeated across sibling
        // cells/plugins/leaves (generic fields and VMAD alike) is resolved at most once.
        var resolveFormKey = FormKeyResolutionCache.Memoize(repository.Resolve);

        var stack = repository.GetOverrideStack(formKey);
        if (stack == null) return null;

        // #421: GetOverrideStack already resolved which record type this FormKey belongs to (the
        // loop this replaced tried every schema table in turn until one had overrides) — one call
        // where this used to be a scan.
        var committedOverrides = stack.Entries.Select(e => ToRecordDetail(e.Effective)).ToList();

        var sessionPlugins = RequireSession().Plugins;
        // #34 / ADR-0036: keyed by the compound column identity, like everything else here
        // since #272. These two were the last filename-keyed structures in this method, safe
        // only while a session could hold at most one plugin per filename — with a second copy
        // loaded, a filename key is ambiguous, and ToDictionary throws outright.
        var pluginMasters = sessionPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Masters);
        // #267 / ADR-0035: a non-participating plugin's override is indexed and browsable but
        // never contributes to conflict classification.
        var pluginParticipates = sessionPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Participates);
        var classification = _conflictClassifier.Classify(committedOverrides, pluginMasters, resolveFormKey, pluginParticipates);
        // #272 / ADR-0036: two live bugs fixed together here, both invisible on the
        // pre-#272 suite because every fixture used the elided Data origin.
        // (1) o.Origin was omitted from the CompareOverride constructor call entirely, so
        //     every override silently defaulted to PluginOrigin.DataDirectory regardless of
        //     its real origin — the wire's own `overrides[].origin` field was never correct
        //     for a non-Data-origin plugin.
        // (2) classification.PluginStates is keyed by ColumnKey.Of(o.Plugin, o.Origin) since
        //     B3, but this looked it up by bare o.Plugin — a miss for any non-Data-origin
        //     column, silently defaulting ConflictThis to OnlyOne. Elision only spares
        //     Data-origin plugins, and #269 records the providing mod folder as origin for
        //     nearly every plugin in a real session, so this was live for essentially every
        //     conflicted record, not just a hypothetical two-origin case.
        var annotated = committedOverrides
            .ConvertAll(o => new CompareOverride(
                o.FormKey, o.Plugin, o.LoadOrderIndex, o.IsWinner, o.EditorId, o.Fields,
                classification.PluginStates.GetValueOrDefault(ColumnKey.Of(o.Plugin, o.Origin), ConflictThis.OnlyOne),
                Origin: o.Origin, RecordType: o.RecordType));

        // #421: VMAD/conditions are rejected from IRecordReads — reconstituted here instead, from
        // each entry's own document body (RecordDocumentCodecs, relocated from Records/). #421
        // ships Head == Effective, so reading Effective is exactly what the old repository.GetVmad/
        // GetConditions calls answered.
        var gameRelease = RequireSession().GameRelease;
        // VMAD is outside the generic reflection pipeline, so classify it separately and fold
        // its conflict contribution into the record-level ConflictAll (computed on demand, never stored).
        var vmadInputs = stack.Entries
            .Select(e => new VmadPluginInput(
                e.Plugin.Name, e.LoadOrderIndex, RecordDocumentCodecs.GetVmad(e.Effective, gameRelease, _logger), e.Plugin.Origin!))
            .ToList();
        VmadCompare? vmad = null;
        var conflictAll = classification.ConflictAll;
        if (vmadInputs.Any(i => i.Vmad != null))
        {
            var vmadResult = VmadConflictClassifier.Classify(vmadInputs, resolveFormKey, pluginParticipates);
            vmad = vmadResult.Compare;
            conflictAll = ConflictRules.Escalate(conflictAll, vmadResult.ConflictContribution);
        }

        // Conditions (CTDA) are outside the reflection pipeline too — classify separately and
        // fold their contribution into the record-level ConflictAll, mirroring VMAD. [ADR-0032]
        var conditionCodec = ConditionCodecRegistry.For(gameRelease.ToCategory());
        var conditionInputs = stack.Entries
            .Select(e => new ConditionPluginInput(
                e.Plugin.Name, e.LoadOrderIndex, RecordDocumentCodecs.GetConditions(e.Effective, gameRelease, conditionCodec), e.Plugin.Origin!))
            .ToList();
        ConditionCompare? conditions = null;
        if (conditionInputs.Any(i => i.Owners.Count > 0))
        {
            var conditionResult = ConditionConflictClassifier.Classify(conditionInputs, resolveFormKey, pluginParticipates);
            conditions = conditionResult.Compare;
            conflictAll = ConflictRules.Escalate(conflictAll, conditionResult.ConflictContribution);
        }

        var hasVmad = RequireSchemas()[stack.RecordType].HasVmad;
        return new CompareResult(annotated, classification.Diffs, conflictAll, hasVmad, vmad, conditions);
    }

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null)
    {
        var repository = RequireRepository();
        // #34: stated by the caller when it knows which copy it is browsing (a tree row does),
        // else resolved server-side from the load order as it has been since #296.
        origin ??= PluginOriginResolver.Resolve(_session.Session, plugin);
        var schemas = RequireSchemas();

        // #421: one grouped query (GetRecordTypeCounts) replaces the per-type CountRecordsForPlugin
        // loop — the header is never in `records` (D8), so it is already absent from the result
        // without an explicit exclusion.
        return [.. repository.GetRecordTypeCounts(new PluginKey(plugin, origin))
            .Where(c => schemas.ContainsKey(c.Type))
            .Select(c => new PluginRecordTypeCount(c.Type, c.Count, schemas.DisplayNameFor(c.Type)))
            .OrderBy(r => r.Type)];
    }

    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) =>
        RequireRepository().GetReferencedBy(targetFormKey);

    public IReadOnlyList<string> GetConditionFunctions() =>
        ConditionCodecRegistry.For(RequireSession().GameRelease.ToCategory())?.AvailableFunctions().ToList() ?? [];

    public IReadOnlyList<string> GetConditionRunOnTargets() =>
        ConditionCodecRegistry.For(RequireSession().GameRelease.ToCategory())?.AvailableRunOnTargets().ToList() ?? [];

    private static RecordDetail ToRecordDetail(RecordDocument document) =>
        new(document.FormKey, document.Plugin.Name, document.LoadOrderIndex, document.IsWinner, document.EditorId,
            document.Fields, Origin: document.Plugin.Origin!, RecordType: document.RecordType);

    private IGameSession RequireSession() =>
        _session.Session ?? throw new InvalidOperationException("No session loaded.");

    private IRecordReads RequireRepository() =>
        _session.Repository ?? throw new InvalidOperationException("No session loaded.");

    private IReadOnlyDictionary<string, Schema.RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(RequireSession().GameRelease);
}
