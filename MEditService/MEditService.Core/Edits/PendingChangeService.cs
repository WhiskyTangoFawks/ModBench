using System.Collections.Concurrent;
using System.Text.Json;

namespace MEditService.Core.Edits;

public sealed class PendingChangeService : IPendingChangeService
{
    private readonly ConcurrentDictionary<(string FormKey, string Plugin, string FieldPath), PendingChange> _changes = new();

    public IReadOnlyList<PendingChange> Upsert(
        string formKey,
        string plugin,
        string recordType,
        Dictionary<string, JsonElement> fields,
        string source,
        string? description,
        Dictionary<string, JsonElement> oldValues)
    {
        var result = new List<PendingChange>(fields.Count);
        foreach (var (field, newValue) in fields)
        {
            var key = (formKey, plugin, field);
            var now = DateTime.UtcNow;

            var updated = _changes.AddOrUpdate(key,
                _ =>
                {
                    var old = oldValues.TryGetValue(field, out var ov) ? ov : JsonDocument.Parse("null").RootElement.Clone();
                    return new PendingChange(Guid.NewGuid(), formKey, plugin, field, recordType, old, newValue, source, description, now);
                },
                (_, existing) => existing with { NewValue = newValue, ChangedAt = now });

            result.Add(updated);
        }
        return result;
    }

    public IReadOnlyList<PendingChange> GetChanges(string? plugin = null, string? formKey = null)
    {
        var values = _changes.Values.AsEnumerable();
        if (plugin != null)  values = values.Where(c => c.Plugin  == plugin);
        if (formKey != null) values = values.Where(c => c.FormKey == formKey);
        return values.OrderBy(c => c.ChangedAt).ToList();
    }

    public Dictionary<string, JsonElement>? GetPendingFields(string formKey, string plugin)
    {
        var fields = _changes.Values
            .Where(c => c.FormKey == formKey && c.Plugin == plugin)
            .ToDictionary(c => c.FieldPath, c => c.NewValue);
        return fields.Count == 0 ? null : fields;
    }

    public bool Revert(Guid changeId)
    {
        var key = _changes.FirstOrDefault(kv => kv.Value.Id == changeId).Key;
        if (key == default) return false;
        return _changes.TryRemove(key, out _);
    }

    public int Revert(string? plugin, string? formKey)
    {
        var toRemove = _changes
            .Where(kv =>
                (plugin  == null || kv.Value.Plugin  == plugin) &&
                (formKey == null || kv.Value.FormKey == formKey))
            .Select(kv => kv.Key)
            .ToList();

        int count = 0;
        foreach (var key in toRemove)
            if (_changes.TryRemove(key, out _)) count++;
        return count;
    }

    public IReadOnlyList<PendingChange> DrainForPlugin(string plugin)
    {
        var toRemove = _changes.Where(kv => kv.Value.Plugin == plugin).ToList();
        var drained = new List<PendingChange>(toRemove.Count);
        foreach (var kv in toRemove)
            if (_changes.TryRemove(kv.Key, out var change))
                drained.Add(change);
        return drained;
    }
}
