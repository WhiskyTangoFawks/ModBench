using System.Data;
using System.Text.Json;
using DuckDB.NET.Data;

namespace MEditService.Core.Edits;

public sealed class DuckDbPendingChangeService : IPendingChangeService, IPendingChangeLifecycle
{
    private readonly Lock _lock = new();
    private DuckDBConnection? _connection;

    public DuckDbPendingChangeService(DuckDBConnection connection) =>
        ((IPendingChangeLifecycle)this).OnSessionLoaded(connection);

    public DuckDbPendingChangeService() { }

    void IPendingChangeLifecycle.OnSessionLoaded(DuckDBConnection connection)
    {
        lock (_lock)
        {
            _connection = connection;
            EnsureTable(connection);
        }
    }

    void IPendingChangeLifecycle.OnSessionUnloaded()
    {
        lock (_lock)
        {
            if (_connection != null)
            {
                DropTable(_connection);
                _connection = null;
            }
        }
    }

    internal static void EnsureTable(DuckDBConnection connection)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS pending_changes (
                id          VARCHAR     NOT NULL,
                form_key    VARCHAR     NOT NULL,
                plugin      VARCHAR     NOT NULL,
                field_path  VARCHAR     NOT NULL,
                record_type VARCHAR     NOT NULL,
                old_value   VARCHAR     NOT NULL,
                new_value   VARCHAR     NOT NULL,
                source      VARCHAR     NOT NULL,
                description VARCHAR,
                changed_at  TIMESTAMP   NOT NULL,
                group_id    VARCHAR,
                PRIMARY KEY (form_key, plugin, field_path)
            )
            """;
        cmd.ExecuteNonQuery();
    }

    private static void DropTable(DuckDBConnection connection)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "DROP TABLE IF EXISTS pending_changes";
        cmd.ExecuteNonQuery();
    }

    private DuckDBConnection RequireConnection() =>
        _connection ?? throw new InvalidOperationException("No session loaded.");

    private static (string Where, List<object> Params) BuildFilter(string? plugin, string? formKey)
    {
        var conditions = new List<string>();
        var paramValues = new List<object>();
        if (plugin != null) { conditions.Add($"plugin = ${paramValues.Count + 1}"); paramValues.Add(plugin); }
        if (formKey != null) { conditions.Add($"form_key = ${paramValues.Count + 1}"); paramValues.Add(formKey); }
        var where = conditions.Count > 0 ? " WHERE " + string.Join(" AND ", conditions) : "";
        return (where, paramValues);
    }

    public IReadOnlyList<PendingChange> Upsert(
        string formKey,
        string plugin,
        string recordType,
        Dictionary<string, JsonElement> fields,
        string source,
        string? description,
        Dictionary<string, JsonElement> oldValues)
    {
        lock (_lock)
        {
            var conn = RequireConnection();
            var result = new List<PendingChange>(fields.Count);
            var now = DateTime.UtcNow;

            using var txn = conn.BeginTransaction();
            foreach (var (field, newValue) in fields)
            {
                var id = Guid.NewGuid().ToString();
                var oldRaw = oldValues.TryGetValue(field, out var ov) ? ov.GetRawText() : "null";

                using var cmd = conn.CreateCommand();
                cmd.CommandText = """
                    INSERT INTO pending_changes
                        (id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (form_key, plugin, field_path) DO UPDATE SET
                        new_value   = excluded.new_value,
                        changed_at  = excluded.changed_at,
                        source      = excluded.source,
                        description = excluded.description
                    RETURNING id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at
                    """;
                cmd.Parameters.Add(new DuckDBParameter { Value = id });
                cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
                cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
                cmd.Parameters.Add(new DuckDBParameter { Value = field });
                cmd.Parameters.Add(new DuckDBParameter { Value = recordType });
                cmd.Parameters.Add(new DuckDBParameter { Value = oldRaw });
                cmd.Parameters.Add(new DuckDBParameter { Value = newValue.GetRawText() });
                cmd.Parameters.Add(new DuckDBParameter { Value = source });
                cmd.Parameters.Add(new DuckDBParameter { Value = description });
                cmd.Parameters.Add(new DuckDBParameter { Value = now });

                using var reader = cmd.ExecuteReader();
                if (reader.Read())
                    result.Add(ReadChange(reader));
            }
            txn.Commit();

            return result;
        }
    }

    public IReadOnlyList<PendingChange> GetChanges(string? plugin = null, string? formKey = null)
    {
        lock (_lock)
        {
            var conn = RequireConnection();
            var (where, paramValues) = BuildFilter(plugin, formKey);

            using var cmd = conn.CreateCommand();
            cmd.CommandText = $"""
                SELECT id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at
                FROM pending_changes{where}
                ORDER BY changed_at
                """;
            foreach (var v in paramValues)
                cmd.Parameters.Add(new DuckDBParameter { Value = v });

            var result = new List<PendingChange>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
                result.Add(ReadChange(reader));
            return result;
        }
    }

    public Dictionary<string, JsonElement>? GetPendingFields(string formKey, string plugin)
    {
        lock (_lock)
        {
            var conn = RequireConnection();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                SELECT field_path, new_value
                FROM pending_changes
                WHERE form_key = $1 AND plugin = $2
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin });

            var result = new Dictionary<string, JsonElement>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var fieldPath = reader.GetString(0);
                var json = reader.GetString(1);
                using var doc = JsonDocument.Parse(json);
                result[fieldPath] = doc.RootElement.Clone();
            }
            return result.Count == 0 ? null : result;
        }
    }

    public bool Revert(Guid changeId)
    {
        lock (_lock)
        {
            var conn = RequireConnection();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "DELETE FROM pending_changes WHERE id = $1";
            cmd.Parameters.Add(new DuckDBParameter { Value = changeId.ToString() });
            return cmd.ExecuteNonQuery() > 0;
        }
    }

    public int Revert(string? plugin, string? formKey)
    {
        lock (_lock)
        {
            var conn = RequireConnection();
            var (where, paramValues) = BuildFilter(plugin, formKey);

            using var cmd = conn.CreateCommand();
            cmd.CommandText = $"DELETE FROM pending_changes{where}";
            foreach (var v in paramValues)
                cmd.Parameters.Add(new DuckDBParameter { Value = v });
            return cmd.ExecuteNonQuery();
        }
    }

    public IReadOnlyList<PendingChange> DrainForPlugin(string plugin)
    {
        lock (_lock)
        {
            var conn = RequireConnection();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                DELETE FROM pending_changes
                WHERE plugin = $1
                RETURNING id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin });

            var drained = new List<PendingChange>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
                drained.Add(ReadChange(reader));
            return drained;
        }
    }

    private static PendingChange ReadChange(DuckDBDataReader reader)
    {
        var id = Guid.Parse(reader.GetString(0));
        var formKey = reader.GetString(1);
        var plugin = reader.GetString(2);
        var fieldPath = reader.GetString(3);
        var recordType = reader.GetString(4);
        var oldValueJson = reader.GetString(5);
        var newValueJson = reader.GetString(6);
        var source = reader.GetString(7);
        var description = reader.IsDBNull(8) ? null : reader.GetString(8);
        var changedAt = reader.GetDateTime(9);

        using var oldDoc = JsonDocument.Parse(oldValueJson);
        var oldValue = oldDoc.RootElement.Clone();
        using var newDoc = JsonDocument.Parse(newValueJson);
        var newValue = newDoc.RootElement.Clone();

        return new PendingChange(id, formKey, plugin, fieldPath, recordType, oldValue, newValue, source, description, changedAt);
    }
}
