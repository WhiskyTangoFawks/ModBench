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
            );
            CREATE TABLE IF NOT EXISTS pending_form_references (
                source_form_key VARCHAR NOT NULL,
                source_plugin   VARCHAR NOT NULL,
                target_form_key VARCHAR NOT NULL,
                field_path      VARCHAR NOT NULL,
                staged_field    VARCHAR NOT NULL,
                record_type     VARCHAR NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pfr_target
                ON pending_form_references(target_form_key);
            """;
        cmd.ExecuteNonQuery();
    }

    private static void DropTable(DuckDBConnection connection)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = """
            DROP TABLE IF EXISTS pending_form_references;
            DROP TABLE IF EXISTS pending_changes;
            """;
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
        Dictionary<string, JsonElement> oldValues,
        IReadOnlyList<PendingFormRef>? formRefs = null)
    {
        lock (_lock)
        {
            formRefs ??= [];
            var conn = RequireConnection();
            var refsByField = formRefs.ToLookup(r => r.StagedField);
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

                // Replace pending form refs for this field
                using var del = conn.CreateCommand();
                del.CommandText = """
                    DELETE FROM pending_form_references
                    WHERE source_form_key = $1 AND source_plugin = $2 AND staged_field = $3
                    """;
                del.Parameters.Add(new DuckDBParameter { Value = formKey });
                del.Parameters.Add(new DuckDBParameter { Value = plugin });
                del.Parameters.Add(new DuckDBParameter { Value = field });
                del.ExecuteNonQuery();

                foreach (var r in refsByField[field])
                {
                    using var ins = conn.CreateCommand();
                    ins.CommandText = """
                        INSERT INTO pending_form_references
                            (source_form_key, source_plugin, target_form_key, field_path, staged_field, record_type)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        """;
                    ins.Parameters.Add(new DuckDBParameter { Value = formKey });
                    ins.Parameters.Add(new DuckDBParameter { Value = plugin });
                    ins.Parameters.Add(new DuckDBParameter { Value = r.TargetFormKey });
                    ins.Parameters.Add(new DuckDBParameter { Value = r.FieldPath });
                    ins.Parameters.Add(new DuckDBParameter { Value = field });
                    ins.Parameters.Add(new DuckDBParameter { Value = recordType });
                    ins.ExecuteNonQuery();
                }
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

    public IReadOnlyList<(string FormKey, string RecordType)> GetStagedFormKeys(string plugin, string? recordType = null)
    {
        lock (_lock)
        {
            var conn = RequireConnection();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT DISTINCT form_key, record_type FROM pending_changes WHERE plugin = $1 AND ($2 IS NULL OR record_type = $2)";
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
            cmd.Parameters.Add(new DuckDBParameter { Value = (object?)recordType });

            var result = new List<(string, string)>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
                result.Add((reader.GetString(0), reader.GetString(1)));
            return result;
        }
    }

    public bool Revert(Guid changeId)
    {
        lock (_lock)
        {
            var conn = RequireConnection();
            using var txn = conn.BeginTransaction();

            using var cmd = conn.CreateCommand();
            cmd.CommandText = "DELETE FROM pending_changes WHERE id = $1 RETURNING form_key, plugin, field_path";
            cmd.Parameters.Add(new DuckDBParameter { Value = changeId.ToString() });

            using var reader = cmd.ExecuteReader();
            if (!reader.Read()) return false;
            var fk = reader.GetString(0);
            var pl = reader.GetString(1);
            var fp = reader.GetString(2);

            using var del = conn.CreateCommand();
            del.CommandText = """
                DELETE FROM pending_form_references
                WHERE source_form_key = $1 AND source_plugin = $2 AND staged_field = $3
                """;
            del.Parameters.Add(new DuckDBParameter { Value = fk });
            del.Parameters.Add(new DuckDBParameter { Value = pl });
            del.Parameters.Add(new DuckDBParameter { Value = fp });
            del.ExecuteNonQuery();

            txn.Commit();
            return true;
        }
    }

    public int Revert(string? plugin, string? formKey)
    {
        lock (_lock)
        {
            var conn = RequireConnection();
            var (where, paramValues) = BuildFilter(plugin, formKey);
            var (refWhere, refParams) = BuildPendingRefFilter(plugin, formKey);

            using var txn = conn.BeginTransaction();

            using var del = conn.CreateCommand();
            del.CommandText = $"DELETE FROM pending_form_references{refWhere}";
            foreach (var v in refParams)
                del.Parameters.Add(new DuckDBParameter { Value = v });
            del.ExecuteNonQuery();

            using var cmd = conn.CreateCommand();
            cmd.CommandText = $"DELETE FROM pending_changes{where}";
            foreach (var v in paramValues)
                cmd.Parameters.Add(new DuckDBParameter { Value = v });
            var count = cmd.ExecuteNonQuery();

            txn.Commit();
            return count;
        }
    }

    private static (string Where, List<object> Params) BuildPendingRefFilter(string? plugin, string? formKey)
    {
        var conditions = new List<string>();
        var paramValues = new List<object>();
        if (plugin != null) { conditions.Add($"source_plugin = ${paramValues.Count + 1}"); paramValues.Add(plugin); }
        if (formKey != null) { conditions.Add($"source_form_key = ${paramValues.Count + 1}"); paramValues.Add(formKey); }
        var where = conditions.Count > 0 ? " WHERE " + string.Join(" AND ", conditions) : "";
        return (where, paramValues);
    }

    public DrainResult DrainForPlugin(string plugin)
    {
        lock (_lock)
        {
            var conn = RequireConnection();

            // Snapshot form refs before atomically removing both tables
            var refsList = new List<(string SourceFormKey, PendingFormRef Ref)>();
            using (var refCmd = conn.CreateCommand())
            {
                refCmd.CommandText = """
                    SELECT source_form_key, staged_field, field_path, target_form_key
                    FROM pending_form_references
                    WHERE source_plugin = $1
                    """;
                refCmd.Parameters.Add(new DuckDBParameter { Value = plugin });
                using var refReader = refCmd.ExecuteReader();
                while (refReader.Read())
                    refsList.Add((
                        refReader.GetString(0),
                        new PendingFormRef(refReader.GetString(1), refReader.GetString(2), refReader.GetString(3))));
            }

            using var txn = conn.BeginTransaction();

            using var del = conn.CreateCommand();
            del.CommandText = "DELETE FROM pending_form_references WHERE source_plugin = $1";
            del.Parameters.Add(new DuckDBParameter { Value = plugin });
            del.ExecuteNonQuery();

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

            txn.Commit();
            return new DrainResult(drained, refsList.ToLookup(x => x.SourceFormKey, x => x.Ref));
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
