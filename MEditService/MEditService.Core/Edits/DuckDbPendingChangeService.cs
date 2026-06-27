using System.Data;
using System.Text.Json;
using DuckDB.NET.Data;

namespace MEditService.Core.Edits;

public sealed class DuckDbPendingChangeService : IPendingChangeService, IPendingChangeLifecycle, IDisposable
{
    private readonly SemaphoreSlim _sem = new(1, 1);
    private DuckDBConnection? _connection;

    public DuckDbPendingChangeService(DuckDBConnection connection) =>
        ((IPendingChangeLifecycle)this).OnSessionLoaded(connection);

    public DuckDbPendingChangeService() { }

    void IPendingChangeLifecycle.OnSessionLoaded(DuckDBConnection connection)
    {
        _sem.Wait();
        try
        {
            _connection = connection;
            EnsureTable(connection);
        }
        finally { _sem.Release(); }
    }

    void IPendingChangeLifecycle.OnSessionUnloaded()
    {
        _sem.Wait();
        try
        {
            if (_connection != null)
            {
                DropTable(_connection);
                _connection = null;
            }
        }
        finally { _sem.Release(); }
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
                change_type VARCHAR     NOT NULL DEFAULT 'field_edit',
                parent_cell     VARCHAR,
                placement_group VARCHAR,
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
            CREATE TABLE IF NOT EXISTS change_groups (
                id          VARCHAR   PRIMARY KEY,
                operation   VARCHAR   NOT NULL,
                description VARCHAR,
                created_at  TIMESTAMP NOT NULL
            );
            """;
        cmd.ExecuteNonQuery();
    }

    private static void DropTable(DuckDBConnection connection)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = """
            DROP TABLE IF EXISTS pending_form_references;
            DROP TABLE IF EXISTS pending_changes;
            DROP TABLE IF EXISTS change_groups;
            """;
        cmd.ExecuteNonQuery();
    }

    private DuckDBConnection RequireConnection() =>
        _connection ?? throw new InvalidOperationException("No session loaded.");

    private static (string Where, List<object> Params) BuildFilter(string? plugin, string? formKey, Guid? groupId = null)
    {
        var conditions = new List<string>();
        var paramValues = new List<object>();
        if (plugin != null) { conditions.Add($"plugin = ${paramValues.Count + 1}"); paramValues.Add(plugin); }
        if (formKey != null) { conditions.Add($"form_key = ${paramValues.Count + 1}"); paramValues.Add(formKey); }
        if (groupId != null) { conditions.Add($"group_id = ${paramValues.Count + 1}"); paramValues.Add(groupId.Value.ToString()); }
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
        IReadOnlyList<PendingFormRef>? formRefs = null,
        string changeType = PendingChangeConstants.FieldEditChangeType,
        Guid? groupId = null,
        string? parentCell = null,
        string? placementGroup = null)
    {
        _sem.Wait();
        try
        {
            formRefs ??= [];
            var conn = RequireConnection();
            var refsByField = formRefs.ToLookup(r => r.StagedField);
            var result = new List<PendingChange>(fields.Count);
            var now = DateTime.UtcNow;

            using var txn = conn.BeginTransaction();

            if (groupId != null)
            {
                using var insGroup = conn.CreateCommand();
                insGroup.CommandText = """
                    INSERT INTO change_groups (id, operation, description, created_at)
                    VALUES ($1, 'create', NULL, $2)
                    ON CONFLICT DO NOTHING
                    """;
                insGroup.Parameters.Add(new DuckDBParameter { Value = groupId.Value.ToString() });
                insGroup.Parameters.Add(new DuckDBParameter { Value = now });
                insGroup.ExecuteNonQuery();
            }

            foreach (var (field, newValue) in fields)
            {
                var id = Guid.NewGuid().ToString();
                var oldRaw = oldValues.TryGetValue(field, out var ov) ? ov.GetRawText() : "null";

                using var cmd = conn.CreateCommand();
                cmd.CommandText = """
                    INSERT INTO pending_changes
                        (id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at, change_type, group_id, parent_cell, placement_group)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                    ON CONFLICT (form_key, plugin, field_path) DO UPDATE SET
                        new_value   = excluded.new_value,
                        changed_at  = excluded.changed_at,
                        source      = excluded.source,
                        description = excluded.description,
                        change_type = excluded.change_type,
                        group_id    = COALESCE(pending_changes.group_id, excluded.group_id)
                    RETURNING id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at, change_type, group_id, parent_cell, placement_group
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
                cmd.Parameters.Add(new DuckDBParameter { Value = changeType });
                cmd.Parameters.Add(new DuckDBParameter { Value = groupId.HasValue ? (object)groupId.Value.ToString() : DBNull.Value });
                cmd.Parameters.Add(new DuckDBParameter { Value = (object?)parentCell ?? DBNull.Value });
                cmd.Parameters.Add(new DuckDBParameter { Value = (object?)placementGroup ?? DBNull.Value });

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
        finally { _sem.Release(); }
    }

    public IReadOnlyList<PendingChange> GetChanges(string? plugin = null, string? formKey = null, Guid? groupId = null)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            var (where, paramValues) = BuildFilter(plugin, formKey, groupId);
            return DoSelectChanges(conn, where, paramValues);
        }
        finally { _sem.Release(); }
    }

    private static List<PendingChange> DoSelectChanges(DuckDBConnection conn, string where, List<object> paramValues)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            SELECT id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at, change_type, group_id, parent_cell, placement_group
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

    public Dictionary<string, JsonElement>? GetPendingFields(string formKey, string plugin)
    {
        _sem.Wait();
        try
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
        finally { _sem.Release(); }
    }

    public IReadOnlyList<(string FormKey, string RecordType)> GetStagedFormKeys(string plugin, string? recordType = null)
    {
        _sem.Wait();
        try
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
        finally { _sem.Release(); }
    }

    public RevertChangeResult Revert(Guid changeId)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            var changeIdStr = changeId.ToString();

            using var txn = conn.BeginTransaction();

            using var check = conn.CreateCommand();
            check.CommandText = "SELECT group_id, form_key, plugin, field_path FROM pending_changes WHERE id = $1";
            check.Parameters.Add(new DuckDBParameter { Value = changeIdStr });

            string? fk, pl, fp;
            using (var checkReader = check.ExecuteReader())
            {
                if (!checkReader.Read())
                    return new RevertChangeResult.NotFound();
                if (!checkReader.IsDBNull(0))
                    return new RevertChangeResult.GroupOwned(Guid.Parse(checkReader.GetString(0)));
                fk = checkReader.GetString(1);
                pl = checkReader.GetString(2);
                fp = checkReader.GetString(3);
            }

            using var cmd = conn.CreateCommand();
            cmd.CommandText = "DELETE FROM pending_changes WHERE id = $1";
            cmd.Parameters.Add(new DuckDBParameter { Value = changeIdStr });
            cmd.ExecuteNonQuery();

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
            return new RevertChangeResult.Reverted();
        }
        finally { _sem.Release(); }
    }

    public int Revert(string? plugin, string? formKey)
    {
        _sem.Wait();
        try
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
        finally { _sem.Release(); }
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
        _sem.Wait();
        try
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
                RETURNING id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at, change_type, group_id, parent_cell, placement_group
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin });

            var drained = new List<PendingChange>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
                drained.Add(ReadChange(reader));

            txn.Commit();
            return new DrainResult(drained, refsList.ToLookup(x => x.SourceFormKey, x => x.Ref));
        }
        finally { _sem.Release(); }
    }

    public IReadOnlyList<ChangeGroup> GetChangeGroups()
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                SELECT cg.id, cg.operation, cg.description, cg.created_at,
                       CAST(COUNT(pc.id) AS INTEGER) AS change_count,
                       CAST(COUNT(DISTINCT pc.plugin) AS INTEGER) AS plugin_count
                FROM change_groups cg
                LEFT JOIN pending_changes pc ON pc.group_id = cg.id
                GROUP BY cg.id, cg.operation, cg.description, cg.created_at
                """;

            var result = new List<ChangeGroup>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var id = Guid.Parse(reader.GetString(0));
                var operation = reader.GetString(1);
                var description = reader.IsDBNull(2) ? null : reader.GetString(2);
                var createdAt = reader.GetDateTime(3);
                var changeCount = reader.GetInt32(4);
                var pluginCount = reader.GetInt32(5);
                result.Add(new ChangeGroup(id, operation, description, createdAt, changeCount, pluginCount));
            }
            return result;
        }
        finally { _sem.Release(); }
    }

    public bool RevertGroup(Guid groupId)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            var groupIdStr = groupId.ToString();

            // Collect (form_key, plugin, field_path) for form-ref cleanup before we delete them
            var groupFields = new List<(string FormKey, string Plugin, string FieldPath)>();
            using (var selectCmd = conn.CreateCommand())
            {
                selectCmd.CommandText = "SELECT form_key, plugin, field_path FROM pending_changes WHERE group_id = $1";
                selectCmd.Parameters.Add(new DuckDBParameter { Value = groupIdStr });
                using var selectReader = selectCmd.ExecuteReader();
                while (selectReader.Read())
                    groupFields.Add((selectReader.GetString(0), selectReader.GetString(1), selectReader.GetString(2)));
            }

            using var txn = conn.BeginTransaction();

            foreach (var (fk, pl, fp) in groupFields)
            {
                using var delRef = conn.CreateCommand();
                delRef.CommandText = """
                    DELETE FROM pending_form_references
                    WHERE source_form_key = $1 AND source_plugin = $2 AND staged_field = $3
                    """;
                delRef.Parameters.Add(new DuckDBParameter { Value = fk });
                delRef.Parameters.Add(new DuckDBParameter { Value = pl });
                delRef.Parameters.Add(new DuckDBParameter { Value = fp });
                delRef.ExecuteNonQuery();
            }

            using var delChanges = conn.CreateCommand();
            delChanges.CommandText = "DELETE FROM pending_changes WHERE group_id = $1";
            delChanges.Parameters.Add(new DuckDBParameter { Value = groupIdStr });
            delChanges.ExecuteNonQuery();

            using var delGroup = conn.CreateCommand();
            delGroup.CommandText = "DELETE FROM change_groups WHERE id = $1";
            delGroup.Parameters.Add(new DuckDBParameter { Value = groupIdStr });
            var deleted = delGroup.ExecuteNonQuery();

            txn.Commit();
            return deleted > 0;
        }
        finally { _sem.Release(); }
    }

    public Guid? GetGroupIdForRecord(string formKey, string plugin)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                SELECT group_id FROM pending_changes
                WHERE form_key = $1 AND plugin = $2 AND group_id IS NOT NULL
                ORDER BY group_id
                LIMIT 1
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin });

            using var reader = cmd.ExecuteReader();
            if (!reader.Read()) return null;
            return Guid.Parse(reader.GetString(0));
        }
        finally { _sem.Release(); }
    }

    public string? GetPendingCreateRecordType(string formKey)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = $"""
                SELECT record_type FROM pending_changes
                WHERE form_key = $1 AND field_path = '{PendingChangeConstants.CreateFieldPath}' AND change_type = '{PendingChangeConstants.CreateChangeType}'
                LIMIT 1
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });

            using var reader = cmd.ExecuteReader();
            if (!reader.Read()) return null;
            return reader.GetString(0);
        }
        finally { _sem.Release(); }
    }

    public Guid? GetCreateGroupIdForAny(IReadOnlyList<string> formKeys)
    {
        if (formKeys.Count == 0) return null;
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            using var cmd = conn.CreateCommand();
            var placeholders = string.Join(", ", Enumerable.Range(1, formKeys.Count).Select(i => $"${i}"));
            cmd.CommandText = $"""
                SELECT group_id FROM pending_changes
                WHERE field_path = '{PendingChangeConstants.CreateFieldPath}' AND change_type = '{PendingChangeConstants.CreateChangeType}'
                AND form_key IN ({placeholders})
                LIMIT 1
                """;
            foreach (var key in formKeys)
                cmd.Parameters.Add(new DuckDBParameter { Value = key });
            using var reader = cmd.ExecuteReader();
            if (!reader.Read() || reader.IsDBNull(0)) return null;
            return Guid.Parse(reader.GetString(0));
        }
        finally { _sem.Release(); }
    }

    public ChangeGroup StageGroup(string operation, string? description, IReadOnlyList<GroupMember> members)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            var groupId = Guid.NewGuid();
            var createdAt = DateTime.UtcNow;

            using var txn = conn.BeginTransaction();

            using var insGroup = conn.CreateCommand();
            insGroup.CommandText = """
                INSERT INTO change_groups (id, operation, description, created_at)
                VALUES ($1, $2, $3, $4)
                """;
            insGroup.Parameters.Add(new DuckDBParameter { Value = groupId.ToString() });
            insGroup.Parameters.Add(new DuckDBParameter { Value = operation });
            insGroup.Parameters.Add(new DuckDBParameter { Value = description });
            insGroup.Parameters.Add(new DuckDBParameter { Value = createdAt });
            insGroup.ExecuteNonQuery();

            foreach (var m in members)
            {
                using var ins = conn.CreateCommand();
                ins.CommandText = """
                    INSERT INTO pending_changes
                        (id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at, group_id, change_type, parent_cell, placement_group)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                    ON CONFLICT (form_key, plugin, field_path) DO UPDATE SET
                        new_value   = excluded.new_value,
                        changed_at  = excluded.changed_at,
                        group_id    = COALESCE(pending_changes.group_id, excluded.group_id),
                        change_type = excluded.change_type,
                        source      = excluded.source,
                        description = excluded.description
                    """;
                ins.Parameters.Add(new DuckDBParameter { Value = Guid.NewGuid().ToString() });
                ins.Parameters.Add(new DuckDBParameter { Value = m.FormKey });
                ins.Parameters.Add(new DuckDBParameter { Value = m.Plugin });
                ins.Parameters.Add(new DuckDBParameter { Value = m.FieldPath });
                ins.Parameters.Add(new DuckDBParameter { Value = m.RecordType });
                ins.Parameters.Add(new DuckDBParameter { Value = m.OldValue.GetRawText() });
                ins.Parameters.Add(new DuckDBParameter { Value = m.NewValue.GetRawText() });
                ins.Parameters.Add(new DuckDBParameter { Value = m.Source });
                ins.Parameters.Add(new DuckDBParameter { Value = description });
                ins.Parameters.Add(new DuckDBParameter { Value = createdAt });
                ins.Parameters.Add(new DuckDBParameter { Value = groupId.ToString() });
                ins.Parameters.Add(new DuckDBParameter { Value = m.ChangeType });
                ins.Parameters.Add(new DuckDBParameter { Value = (object?)m.ParentCell ?? DBNull.Value });
                ins.Parameters.Add(new DuckDBParameter { Value = (object?)m.PlacementGroup ?? DBNull.Value });
                ins.ExecuteNonQuery();
            }

            txn.Commit();

            using var countCmd = conn.CreateCommand();
            countCmd.CommandText = "SELECT CAST(COUNT(*) AS INTEGER) FROM pending_changes WHERE group_id = $1";
            countCmd.Parameters.Add(new DuckDBParameter { Value = groupId.ToString() });
            var actualCount = Convert.ToInt32(countCmd.ExecuteScalar()!, System.Globalization.CultureInfo.InvariantCulture);
            var pluginCount = members.Select(m => m.Plugin).Distinct(StringComparer.OrdinalIgnoreCase).Count();
            return new ChangeGroup(groupId, operation, description, createdAt, actualCount, pluginCount);
        }
        finally { _sem.Release(); }
    }

    public async Task<SaveGroupResult> ExecuteGroupSaveAsync(
        Guid groupId,
        Func<IReadOnlyDictionary<string, IReadOnlyList<PendingChange>>, Task<IReadOnlyDictionary<string, SaveResult>>> writeAll)
    {
        await _sem.WaitAsync();
        try
        {
            var conn = RequireConnection();
            var pending = SelectChangesForGroup(conn, groupId);
            if (pending.Count == 0) return new SaveGroupResult.NoChanges();

            var byPlugin = pending
                .GroupBy(c => c.Plugin)
                .ToDictionary(g => g.Key, g => (IReadOnlyList<PendingChange>)g.ToList());

            await using var txn = await conn.BeginTransactionAsync();
            DeleteChangesForGroup(conn, groupId);

            var results = await writeAll(byPlugin);
            await txn.CommitAsync();
            return new SaveGroupResult.Saved(results);
        }
        finally { _sem.Release(); }
    }

    private static List<PendingChange> SelectChangesForGroup(DuckDBConnection conn, Guid groupId)
    {
        var (where, paramValues) = BuildFilter(null, null, groupId);
        return DoSelectChanges(conn, where, paramValues);
    }

    private static void DeleteChangesForGroup(DuckDBConnection conn, Guid groupId)
    {
        var groupIdStr = groupId.ToString();

        using var delRefs = conn.CreateCommand();
        delRefs.CommandText = """
            DELETE FROM pending_form_references
            WHERE (source_form_key, source_plugin, staged_field) IN (
                SELECT form_key, plugin, field_path FROM pending_changes WHERE group_id = $1
            )
            """;
        delRefs.Parameters.Add(new DuckDBParameter { Value = groupIdStr });
        delRefs.ExecuteNonQuery();

        using var delChanges = conn.CreateCommand();
        delChanges.CommandText = "DELETE FROM pending_changes WHERE group_id = $1";
        delChanges.Parameters.Add(new DuckDBParameter { Value = groupIdStr });
        delChanges.ExecuteNonQuery();

        using var delGroup = conn.CreateCommand();
        delGroup.CommandText = "DELETE FROM change_groups WHERE id = $1";
        delGroup.Parameters.Add(new DuckDBParameter { Value = groupIdStr });
        delGroup.ExecuteNonQuery();
    }

    public void Dispose() => _sem.Dispose();

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
        var changeType = reader.GetString(10);
        var groupId = reader.IsDBNull(11) ? (Guid?)null : Guid.Parse(reader.GetString(11));
        var parentCell = reader.IsDBNull(12) ? null : reader.GetString(12);
        var placementGroup = reader.IsDBNull(13) ? null : reader.GetString(13);

        using var oldDoc = JsonDocument.Parse(oldValueJson);
        var oldValue = oldDoc.RootElement.Clone();
        using var newDoc = JsonDocument.Parse(newValueJson);
        var newValue = newDoc.RootElement.Clone();

        return new PendingChange(id, formKey, plugin, fieldPath, recordType, oldValue, newValue, source, description, changedAt, changeType, groupId, parentCell, placementGroup);
    }
}
