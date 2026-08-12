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
        if (s.FilterSql is null)
            return [.. s.Plugins.Select(PluginResponse.FromMetadata)];

        var matchingPlugins = RequireRepository().GetPluginsWithMatchingRecords(RequireSchemas().Keys);
        return [.. s.Plugins
            .Where(p => matchingPlugins.Contains(p.Name))
            .Select(PluginResponse.FromMetadata)];
    }

    // The header isn't a browsable record type (User Story 7's "expand a plugin -> record types"
    // listing, or an unscoped "all types" search) — it's reached only via "Open Header" on the
    // plugin node. It stays a real schemas.Keys entry so FindRecordType/GetRecord/GetCompare (a
    // direct FormKey lookup) can still resolve it; only these two browse-all-types paths exclude it.
    private const string HeaderTableName = "header";

    public IReadOnlyList<string> GetRecordTypes() =>
        [.. RequireSchemas().Keys.Where(t => t != HeaderTableName).Order()];

    public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset)
    {
        var repository = RequireRepository();
        var schemas = RequireSchemas();

        PagedResult<RecordSummary> committed;
        if (type != null)
        {
            if (!schemas.ContainsKey(type))
                return new PagedResult<RecordSummary>([], 0);
            committed = repository.GetRecords(type, plugin, search, limit, offset);
        }
        else
        {
            committed = repository.SearchRecords(
                [.. schemas.Keys.Where(t => t != HeaderTableName)], plugin, search, limit, offset);
        }

        if (plugin == null || offset > 0)
            return committed;

        var committedKeys = committed.Items.Select(r => r.FormKey).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var staged = _changes.GetStagedFormKeys(plugin, type)
            .Where(s => !committedKeys.Contains(s.FormKey))
            .ToList();

        if (staged.Count == 0)
            return committed;

        var loadOrderIndex = RequireSession().Plugins
            .FirstOrDefault(p => p.Name.Equals(plugin, StringComparison.OrdinalIgnoreCase))?.LoadOrderIndex ?? -1;

        var stagedSummaries = staged
            .ConvertAll(s => new RecordSummary(s.FormKey, plugin, loadOrderIndex, IsWinner: false, EditorId: null));

        return new PagedResult<RecordSummary>(
            [.. committed.Items, .. stagedSummaries],
            committed.Total + staged.Count);
    }

    public RecordDetail? GetRecord(string formKey)
    {
        var repository = RequireRepository();
        var tableName = repository.FindRecordType(formKey);
        return tableName == null ? null : repository.GetRecord(tableName, formKey, plugin: null, winnerOnly: true);
    }

    public RecordDetail? GetRecordForPlugin(string formKey, string plugin)
    {
        var repository = RequireRepository();
        var tableName = repository.FindRecordType(formKey);
        return tableName == null ? null : repository.GetRecord(tableName, formKey, plugin, winnerOnly: false);
    }

    public string? GetRecordType(string formKey) =>
        RequireRepository().FindRecordType(formKey);

    public IReadOnlyList<string> GetNativeFormKeys(string plugin) =>
        RequireRepository().GetNativeFormKeys(plugin);

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
                return pending == null ? o : (o with { PendingFields = pending.ToDictionary(kv => kv.Key, kv => (object?)kv.Value) });
            }).ToList();

            var sessionPlugins = RequireSession().Plugins;
            var pluginMasters = sessionPlugins.ToDictionary(p => p.Name, p => p.Masters);
            // #267 / ADR-0035: a non-participating plugin's override is indexed and browsable but
            // never contributes to conflict classification.
            var pluginParticipates = sessionPlugins.ToDictionary(p => p.Name, p => p.Participates);
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
                    o.RecordType, o.Origin));

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

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin)
    {
        var repository = RequireRepository();
        var counts = RequireSchemas().Keys
            .Where(t => t != HeaderTableName)
            .Select(t => (Type: t, Count: repository.CountRecordsForPlugin(t, plugin)))
            .Where(x => x.Count > 0)
            .ToDictionary(x => x.Type, x => x.Count, StringComparer.OrdinalIgnoreCase);

        foreach (var recordType in _changes.GetStagedFormKeys(plugin)
            .Where(s => !counts.ContainsKey(s.RecordType)
                || repository.GetRecord(s.RecordType, s.FormKey, plugin, winnerOnly: false) == null)
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

    public IReadOnlyList<PendingChange> GetChanges(string? plugin = null, string? formKey = null, Guid? memberChangeId = null)
    {
        var pending = _changes.GetChanges(plugin, formKey, memberChangeId);
        var resolveFormKey = FormKeyResolutionCache.Memoize(RequireRepository().ResolveFormKey);
        return PendingChangeResolver.ResolveAll(pending, RequireSchemas(), resolveFormKey);
    }

    public VmadData? GetVmad(string formKey, string plugin, string origin = PluginOrigin.DataDirectory) =>
        RequireRepository().GetVmad(formKey, plugin, origin);

    public IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin, string origin = PluginOrigin.DataDirectory) =>
        RequireRepository().GetConditions(formKey, plugin, origin);

    public IReadOnlyList<string> GetConditionFunctions() =>
        ConditionCodecRegistry.For(RequireSession().GameRelease.ToCategory())?.AvailableFunctions().ToList() ?? [];

    public IReadOnlyList<string> GetConditionRunOnTargets() =>
        ConditionCodecRegistry.For(RequireSession().GameRelease.ToCategory())?.AvailableRunOnTargets().ToList() ?? [];

    public PlacementRow? GetPlacement(string formKey, string plugin, string origin = PluginOrigin.DataDirectory) =>
        RequireRepository().GetPlacement(formKey, plugin, origin);

    private IGameSession RequireSession() =>
        _session.Session ?? throw new InvalidOperationException("No session loaded.");

    private IRecordReader RequireRepository() =>
        _session.Repository ?? throw new InvalidOperationException("No session loaded.");

    private IReadOnlyDictionary<string, Schema.RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(RequireSession().GameRelease);
}
