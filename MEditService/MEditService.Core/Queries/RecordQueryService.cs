using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Core.Queries;

public sealed class RecordQueryService(
    ISessionManager session,
    IPendingChangeService changes,
    ISchemaReflector schemaReflector,
    IConflictClassifier conflictClassifier) : IRecordQueryService
{
    private readonly ISessionManager _session = session;
    private readonly IPendingChangeService _changes = changes;
    private readonly ISchemaReflector _schemaReflector = schemaReflector;
    private readonly IConflictClassifier _conflictClassifier = conflictClassifier;

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
        PluginResponse ToResponse(PluginMetadata p) =>
            PluginResponse.FromMetadata(p, masterIssues.GetValueOrDefault(p.Name));

        if (s.FilterSql is null)
            return [.. s.Plugins.Select(ToResponse)];

        var matchingPlugins = RequireRepository().GetPluginsWithMatchingRecords(RequireSchemas().Keys);
        return [.. s.Plugins
            .Where(p => matchingPlugins.Contains(p.Name))
            .Select(ToResponse)];
    }

    // The header isn't a browsable record type (User Story 7's "expand a plugin -> record types"
    // listing, or an unscoped "all types" search) — it's reached only via "Open Header" on the
    // plugin node. It stays a real schemas.Keys entry so FindRecordType/GetRecord/GetCompare (a
    // direct FormKey lookup) can still resolve it; only these two browse-all-types paths exclude it.
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

        PagedResult<RecordSummary> committed;
        if (type != null)
        {
            if (!schemas.ContainsKey(type))
                return new PagedResult<RecordSummary>([], 0);
            committed = repository.GetRecords(type, plugin, search, limit, offset, origin);
        }
        else
        {
            committed = repository.SearchRecords(
                [.. schemas.Keys.Where(t => t != HeaderTableName)], plugin, search, limit, offset, origin);
        }

        if (plugin == null || offset > 0)
            return committed;

        var committedKeys = committed.Items.Select(r => r.FormKey).ToHashSet(StringComparer.OrdinalIgnoreCase);
        // #296 review: staged-only records must scope to the same origin as the committed query
        // above — GetStagedFormKeys has accepted an optional origin filter since #272; omitting it
        // here (as this call originally did) let two same-filename origins' staged-only records
        // merge through this path even though the committed side was already correctly scoped.
        var staged = _changes.GetStagedFormKeys(plugin, type, origin)
            .Where(s => !committedKeys.Contains(s.FormKey))
            .ToList();

        if (staged.Count == 0)
            return committed;

        var loadOrderIndex = RequireSession().Plugins
            .FirstOrDefault(p => p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase)
                && p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase))?.LoadOrderIndex ?? -1;

        // origin! : plugin is non-null past the guard above, and origin was resolved from that same
        // plugin nullability check at its declaration (line above), so it is non-null here too — the
        // compiler's flow analysis doesn't carry that correlation across the guard into this closure
        // (confirmed: CS8604 without the forgiveness), hence this instead of a second
        // PluginOriginResolver.Resolve call.
        var stagedSummaries = staged
            .ConvertAll(s => new RecordSummary(s.FormKey, plugin, loadOrderIndex, IsWinner: false, EditorId: null, Origin: origin!));

        return new PagedResult<RecordSummary>(
            [.. committed.Items, .. stagedSummaries],
            committed.Total + staged.Count);
    }

    public RecordDetail? GetRecord(string formKey)
    {
        var repository = RequireRepository();
        var tableName = repository.FindRecordType(formKey);
        return tableName == null ? null : repository.GetRecord(tableName, formKey, plugin: null, origin: null, winnerOnly: true);
    }

    public RecordDetail? GetRecordForPlugin(string formKey, string plugin, string origin)
    {
        var repository = RequireRepository();
        var tableName = repository.FindRecordType(formKey);
        return tableName == null ? null : repository.GetRecord(tableName, formKey, plugin, origin, winnerOnly: false);
    }

    // #336/ADR-0038: replaces the deleted stage-missing-masters step, which used to stage a real
    // pending-change row so the header's masters became the union once saved. This instead
    // answers the union live, every time, with nothing ever staged. Mirrors exactly what that
    // deleted step used to compute when deciding a master was missing: the record's own origin
    // plugin (OriginPluginOf) for every staged FormKey, plus the origin plugin of every FormKey
    // any staged content references.
    public IReadOnlyList<string> GetEffectiveMasters(string plugin, string origin)
    {
        var committed = GetRecordForPlugin(HeaderIndexer.FormKeyFor(plugin), plugin, origin)?.Fields
            .FirstOrDefault(fv => fv.Metadata.Name == HeaderIndexer.MastersFieldName);
        var masters = committed != null ? ReadStringArray(JsonSerializer.SerializeToElement(committed.Value)) : [];
        var mastersSet = new HashSet<string>(masters, StringComparer.OrdinalIgnoreCase);

        var referencedPlugins = new List<string>();
        foreach (var (formKey, _) in _changes.GetStagedFormKeys(plugin, origin: origin))
            if (OriginPluginOf(formKey) is { } originPlugin) referencedPlugins.Add(originPlugin);
        foreach (var targetFormKey in _changes.GetStagedFormRefTargets(plugin, origin))
            if (OriginPluginOf(targetFormKey) is { } refPlugin) referencedPlugins.Add(refPlugin);

        // Sorted, not discovery order: the two queries above have no defined row order, so two
        // calls over identical real facts (e.g. two same-filename/different-origin columns with
        // identical staged content — #333/ADR-0036) must still agree byte for byte. Masters order
        // is itself load-bearing (FormID local-master-index resolution), so an unsorted append
        // here would risk the compare grid flagging a spurious conflict from ordering alone, not
        // real content.
        var missingMasters = referencedPlugins
            .Where(p => !p.Equals(plugin, StringComparison.OrdinalIgnoreCase) && !mastersSet.Contains(p))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(p => p, StringComparer.OrdinalIgnoreCase);

        return [.. masters, .. missingMasters];
    }

    // GetCompare's header-only substitution step: replaces the raw (committed/pending-overlaid)
    // masters field with GetEffectiveMasters' derived value. `with` on a record hierarchy clones
    // the runtime type (RecordDetail here is always actually a CompareOverride, since GetCompare
    // is the only caller), so this stays RecordDetail-typed without a CompareOverride-specific branch.
    private RecordDetail WithEffectiveMasters(RecordDetail detail)
    {
        var mastersJson = JsonSerializer.SerializeToElement(GetEffectiveMasters(detail.Plugin, detail.Origin));
        return detail with
        {
            Fields = [.. detail.Fields.Select(fv =>
                fv.Metadata.Name == HeaderIndexer.MastersFieldName ? fv with { Value = mastersJson } : fv)],
        };
    }

    // The plugin substring of a "FormID:Plugin" FormKey string; null when malformed. Duplicated
    // (also in EditOrchestrator, PendingChangeGraph) rather than extracted to a shared helper —
    // #338 deletes PendingChangeGraph's copy along with the added-master edge rule, so
    // consolidating now would churn code about to vanish; #338 will decide where the survivors land.
    private static string? OriginPluginOf(string formKey)
    {
        var colon = formKey.IndexOf(':');
        return colon >= 0 && colon < formKey.Length - 1 ? formKey[(colon + 1)..] : null;
    }

    private static List<string> ReadStringArray(JsonElement el) =>
        el.ValueKind == JsonValueKind.Array
            ? el.EnumerateArray().Select(e => e.GetString() ?? "").ToList()
            : [];

    public string? GetRecordType(string formKey) =>
        RequireRepository().FindRecordType(formKey);

    public IReadOnlyList<string> GetNativeFormKeys(string plugin, string origin) =>
        RequireRepository().GetNativeFormKeys(plugin, origin);

    public CompareResult? GetCompare(string formKey)
    {
        var repository = RequireRepository();
        // ADR-0031: one memoizing cache per response — a FormKey repeated across sibling
        // cells/plugins/leaves (generic fields and VMAD alike) is resolved at most once.
        var resolveFormKey = FormKeyResolutionCache.Memoize(repository.ResolveFormKey);
        foreach (var tableName in RequireSchemas().Keys)
        {
            var overrides = repository.GetAllOverrides(tableName, formKey);
            if (overrides.Count == 0) continue;

            var withPending = overrides.Select(o =>
            {
                var pending = _changes.GetPendingFields(formKey, o.Plugin, o.Origin);
                var current = pending == null ? o : (o with { PendingFields = pending.ToDictionary(kv => kv.Key, kv => (object?)kv.Value) });
                // #336/ADR-0038: the header's masters field is never itself a pending row anymore
                // (nothing stages one — GetEffectiveMasters is the only source of truth for "what
                // will masters be"), so it needs its own substitution here rather than riding the
                // ordinary pending-field overlay above.
                return tableName == HeaderTableName ? WithEffectiveMasters(current) : current;
            }).ToList();

            var sessionPlugins = RequireSession().Plugins;
            // #34 / ADR-0036: keyed by the compound column identity, like everything else here
            // since #272. These two were the last filename-keyed structures in this method, safe
            // only while a session could hold at most one plugin per filename — with a second copy
            // loaded, a filename key is ambiguous, and ToDictionary throws outright.
            var pluginMasters = sessionPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Masters);
            // #267 / ADR-0035: a non-participating plugin's override is indexed and browsable but
            // never contributes to conflict classification.
            var pluginParticipates = sessionPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Participates);
            var classification = _conflictClassifier.Classify(withPending, pluginMasters, resolveFormKey, pluginParticipates);
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
            var annotated = withPending
                .ConvertAll(o => new CompareOverride(
                    o.FormKey, o.Plugin, o.LoadOrderIndex, o.IsWinner, o.EditorId, o.Fields, o.PendingFields,
                    classification.PluginStates.GetValueOrDefault(ColumnKey.Of(o.Plugin, o.Origin), ConflictThis.OnlyOne),
                    Origin: o.Origin, RecordType: o.RecordType));

            // VMAD is outside the generic reflection pipeline, so classify it separately and fold
            // its conflict contribution into the record-level ConflictAll (computed on demand, never stored).
            var vmadInputs = withPending
                .ConvertAll(o => new VmadPluginInput(o.Plugin, o.LoadOrderIndex, repository.GetVmad(formKey, o.Plugin, o.Origin), o.Origin));
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
            var conditionInputs = withPending
                .ConvertAll(o => new ConditionPluginInput(o.Plugin, o.LoadOrderIndex, repository.GetConditions(formKey, o.Plugin, o.Origin), o.Origin));
            ConditionCompare? conditions = null;
            if (conditionInputs.Any(i => i.Owners.Count > 0))
            {
                var conditionResult = ConditionConflictClassifier.Classify(conditionInputs, resolveFormKey, pluginParticipates);
                conditions = conditionResult.Compare;
                conflictAll = ConflictRules.Escalate(conflictAll, conditionResult.ConflictContribution);
            }

            var hasVmad = RequireSchemas()[tableName].HasVmad;
            return new CompareResult(annotated, classification.Diffs, conflictAll, hasVmad, vmad, conditions);
        }
        return null;
    }

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null)
    {
        var repository = RequireRepository();
        // #34: stated by the caller when it knows which copy it is browsing (a tree row does),
        // else resolved server-side from the load order as it has been since #296.
        origin ??= PluginOriginResolver.Resolve(_session.Session, plugin);
        var counts = RequireSchemas().Keys
            .Where(t => t != HeaderTableName)
            .Select(t => (Type: t, Count: repository.CountRecordsForPlugin(t, plugin, origin)))
            .Where(x => x.Count > 0)
            .ToDictionary(x => x.Type, x => x.Count, StringComparer.OrdinalIgnoreCase);

        // #296 review: scoped to the same resolved origin as the CountRecordsForPlugin loop above —
        // GetStagedFormKeys has accepted an optional origin filter since #272; omitting it here (as
        // this call originally did) let two same-filename origins' staged-only records merge into
        // one plugin's record-type counts even though the committed side was already correctly
        // scoped.
        foreach (var recordType in _changes.GetStagedFormKeys(plugin, origin: origin)
            .Where(s => !counts.ContainsKey(s.RecordType)
                || repository.GetRecord(s.RecordType, s.FormKey, plugin, origin, winnerOnly: false) == null)
            .Select(s => s.RecordType))
        {
            counts.TryGetValue(recordType, out var existing);
            counts[recordType] = existing + 1;
        }

        var schemas = RequireSchemas();
        return [.. counts
            .Select(kv => new PluginRecordTypeCount(kv.Key, kv.Value, schemas.DisplayNameFor(kv.Key)))
            .OrderBy(r => r.Type)];
    }

    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) =>
        RequireRepository().GetReferences(targetFormKey);

    public IReadOnlyList<PendingChange> GetChanges(string? formKey = null, Guid? memberChangeId = null)
    {
        var pending = _changes.GetChanges(formKey: formKey, memberChangeId: memberChangeId);
        var resolveFormKey = FormKeyResolutionCache.Memoize(RequireRepository().ResolveFormKey);
        return PendingChangeResolver.ResolveAll(pending, RequireSchemas(), resolveFormKey);
    }

    public VmadData? GetVmad(string formKey, string plugin, string origin) =>
        RequireRepository().GetVmad(formKey, plugin, origin);

    public IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin, string origin) =>
        RequireRepository().GetConditions(formKey, plugin, origin);

    public IReadOnlyList<string> GetConditionFunctions() =>
        ConditionCodecRegistry.For(RequireSession().GameRelease.ToCategory())?.AvailableFunctions().ToList() ?? [];

    public IReadOnlyList<string> GetConditionRunOnTargets() =>
        ConditionCodecRegistry.For(RequireSession().GameRelease.ToCategory())?.AvailableRunOnTargets().ToList() ?? [];

    public PlacementRow? GetPlacement(string formKey, string plugin, string origin) =>
        RequireRepository().GetPlacement(formKey, plugin, origin);

    private IGameSession RequireSession() =>
        _session.Session ?? throw new InvalidOperationException("No session loaded.");

    private IRecordReader RequireRepository() =>
        _session.Repository ?? throw new InvalidOperationException("No session loaded.");

    private IReadOnlyDictionary<string, Schema.RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(RequireSession().GameRelease);
}
