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
        return s.Plugins.Select(PluginResponse.FromMetadata).ToList();
    }

    public IReadOnlyList<string> GetRecordTypes() =>
        RequireSchemas().Keys.Order().ToList();

    public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset)
    {
        var repository = RequireRepository();
        var schemas = RequireSchemas();

        if (type != null)
        {
            if (!schemas.ContainsKey(type))
                return new PagedResult<RecordSummary>([], 0);
            return repository.GetRecords(type, plugin, search, limit, offset);
        }

        return repository.SearchRecords(schemas.Keys.ToList(), plugin, search, limit, offset);
    }

    public RecordDetail? GetRecord(string formKey)
    {
        var repository = RequireRepository();
        foreach (var tableName in RequireSchemas().Keys)
        {
            var detail = repository.GetRecord(tableName, formKey, plugin: null, winnerOnly: true);
            if (detail != null) return detail;
        }
        return null;
    }

    public RecordDetail? GetRecordForPlugin(string formKey, string plugin)
    {
        var repository = RequireRepository();
        foreach (var tableName in RequireSchemas().Keys)
        {
            var detail = repository.GetRecord(tableName, formKey, plugin, winnerOnly: false);
            if (detail != null) return detail;
        }
        return null;
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

            var diffs = _conflictClassifier.ComputeDiffs(withPending);
            return new CompareResult(withPending, diffs);
        }
        return null;
    }

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin)
    {
        var repository = RequireRepository();
        var result = new List<PluginRecordTypeCount>();
        foreach (var tableName in RequireSchemas().Keys)
        {
            var count = repository.CountRecordsForPlugin(tableName, plugin);
            if (count > 0) result.Add(new PluginRecordTypeCount(tableName, count));
        }
        return result.OrderBy(r => r.Type).ToList();
    }

    private IGameSession RequireSession() =>
        _session.Session ?? throw new InvalidOperationException("No session loaded.");

    private IRecordReader RequireRepository() =>
        _session.Repository ?? throw new InvalidOperationException("No session loaded.");

    private IReadOnlyDictionary<string, Schema.RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(RequireSession().GameRelease);
}
