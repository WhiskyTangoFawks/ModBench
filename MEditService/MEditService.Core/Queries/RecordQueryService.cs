using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;

namespace MEditService.Core.Queries;

public sealed class RecordQueryService : IRecordQueryService
{
    private readonly ISessionManager _session;
    private readonly IPendingChangeService _changes;
    private readonly ISchemaReflector _schemaReflector;
    private readonly IConflictClassifier _conflictClassifier;

    public RecordQueryService(
        ISessionManager session,
        IPendingChangeService changes,
        ISchemaReflector schemaReflector,
        IConflictClassifier conflictClassifier)
    {
        _session = session;
        _changes = changes;
        _schemaReflector = schemaReflector;
        _conflictClassifier = conflictClassifier;
    }

    public IReadOnlyList<PluginResponse> GetPlugins()
    {
        var s = RequireSession();
        if (s.FilterSql is null)
            return s.Plugins.Select(PluginResponse.FromMetadata).ToList();

        var matchingPlugins = RequireRepository().GetPluginsWithMatchingRecords(RequireSchemas().Keys);
        return s.Plugins
            .Where(p => matchingPlugins.Contains(p.Name))
            .Select(PluginResponse.FromMetadata)
            .ToList();
    }

    public IReadOnlyList<string> GetRecordTypes() =>
        RequireSchemas().Keys.Order().ToList();

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
            committed = repository.SearchRecords(schemas.Keys.ToList(), plugin, search, limit, offset);
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
            .Select(s => new RecordSummary(s.FormKey, plugin, loadOrderIndex, IsWinner: false, EditorId: null))
            .ToList();

        return new PagedResult<RecordSummary>(
            [.. committed.Items, .. stagedSummaries],
            committed.Total + staged.Count);
    }

    public RecordDetail? GetRecord(string formKey)
    {
        var repository = RequireRepository();
        var tableName = repository.FindRecordType(formKey);
        if (tableName == null) return null;
        return repository.GetRecord(tableName, formKey, plugin: null, winnerOnly: true);
    }

    public RecordDetail? GetRecordForPlugin(string formKey, string plugin)
    {
        var repository = RequireRepository();
        var tableName = repository.FindRecordType(formKey);
        if (tableName == null) return null;
        return repository.GetRecord(tableName, formKey, plugin, winnerOnly: false);
    }

    public string? GetRecordType(string formKey) =>
        RequireRepository().FindRecordType(formKey);

    public CompareResult? GetCompare(string formKey)
    {
        var repository = RequireRepository();
        foreach (var tableName in RequireSchemas().Keys)
        {
            var overrides = repository.GetAllOverrides(tableName, formKey);
            if (overrides.Count == 0) continue;

            var withPending = overrides.Select(o =>
            {
                var pending = _changes.GetPendingFields(formKey, o.Plugin);
                if (pending == null) return o;
                return o with { PendingFields = pending.ToDictionary(kv => kv.Key, kv => (object?)kv.Value) };
            }).ToList();

            var pluginMasters = RequireSession().Plugins
                .ToDictionary(p => p.Name, p => p.Masters);
            var classification = _conflictClassifier.Classify(withPending, pluginMasters);
            var annotated = withPending
                .Select(o => new CompareOverride(
                    o.FormKey, o.Plugin, o.LoadOrderIndex, o.IsWinner, o.EditorId, o.Fields, o.PendingFields,
                    classification.PluginStates.GetValueOrDefault(o.Plugin, ConflictThis.OnlyOne)))
                .ToList();

            // VMAD is outside the generic reflection pipeline, so classify it separately and fold
            // its conflict contribution into the record-level ConflictAll (computed on demand, never stored).
            var vmadInputs = withPending
                .Select(o => new VmadPluginInput(o.Plugin, o.LoadOrderIndex, repository.GetVmad(formKey, o.Plugin)))
                .ToList();
            VmadCompare? vmad = null;
            var conflictAll = classification.ConflictAll;
            if (vmadInputs.Any(i => i.Vmad != null))
            {
                var vmadResult = VmadConflictClassifier.Classify(vmadInputs);
                vmad = vmadResult.Compare;
                conflictAll = EscalateConflict(conflictAll, vmadResult.ConflictContribution);
            }

            return new CompareResult(annotated, classification.Diffs, conflictAll, vmad);
        }
        return null;
    }

    // Folds a VMAD conflict contribution (NoConflict/Override/Conflict) into the generic record-level
    // result, taking the more severe of the two. OnlyOne (single override) and ConflictCritical
    // (injected) are preserved as-is. Explicit so it does not depend on enum declaration order.
    private static ConflictAll EscalateConflict(ConflictAll generic, ConflictAll vmad) => generic switch
    {
        ConflictAll.OnlyOne or ConflictAll.ConflictCritical => generic,
        ConflictAll.Conflict => ConflictAll.Conflict,
        ConflictAll.Override => vmad == ConflictAll.Conflict ? ConflictAll.Conflict : ConflictAll.Override,
        _ => vmad, // generic == NoConflict: the VMAD contribution wins
    };

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin)
    {
        var repository = RequireRepository();
        var counts = RequireSchemas().Keys
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

        return counts
            .Select(kv => new PluginRecordTypeCount(kv.Key, kv.Value))
            .OrderBy(r => r.Type)
            .ToList();
    }

    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) =>
        RequireRepository().GetReferences(targetFormKey);

    public VmadData? GetVmad(string formKey, string plugin) =>
        RequireRepository().GetVmad(formKey, plugin);

    public PlacementRow? GetPlacement(string formKey, string plugin) =>
        RequireRepository().GetPlacement(formKey, plugin);

    private IGameSession RequireSession() =>
        _session.Session ?? throw new InvalidOperationException("No session loaded.");

    private IRecordReader RequireRepository() =>
        _session.Repository ?? throw new InvalidOperationException("No session loaded.");

    private IReadOnlyDictionary<string, Schema.RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(RequireSession().GameRelease);
}
