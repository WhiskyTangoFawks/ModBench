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
            _connection = null;
        }
        finally { _sem.Release(); }
    }

    // #271 / ADR-0036: `origin` binds a staged edit to the compound identity alongside `plugin` —
    // the PK and every ON CONFLICT target below widen to (form_key, origin, plugin, field_path), so
    // two edits sharing a filename but differing in origin persist as distinct rows instead of the
    // second silently overwriting the first. Defaulted for the same reason as every other origin
    // column introduced this ticket.
    internal static void EnsureTable(DuckDBConnection connection)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            CREATE TABLE IF NOT EXISTS pending_changes (
                id          VARCHAR     NOT NULL,
                form_key    VARCHAR     NOT NULL,
                plugin      VARCHAR     NOT NULL,
                origin      VARCHAR     NOT NULL DEFAULT '{Session.PluginOrigin.DataDirectory}',
                field_path  VARCHAR     NOT NULL,
                record_type VARCHAR     NOT NULL,
                old_value   VARCHAR     NOT NULL,
                new_value   VARCHAR     NOT NULL,
                source      VARCHAR     NOT NULL,
                description VARCHAR,
                changed_at  TIMESTAMP   NOT NULL,
                change_type VARCHAR     NOT NULL DEFAULT 'field_edit',
                parent_cell     VARCHAR,
                placement_group VARCHAR,
                PRIMARY KEY (form_key, origin, plugin, field_path)
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

        // Deriving change groups reads the committed reference index (ADR-0028 edge rule 1), so it
        // must exist wherever pending changes do. Records/ owns the definition; this is the same
        // idempotent DDL, not a second copy of it.
        Records.TableDdlBuilder.CreateFormReferencesTable(connection);
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

    public IReadOnlyList<PendingChange> Upsert(PendingChangeUpsert change)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            var refsByField = (change.FormRefs ?? []).ToLookup(r => r.StagedField);
            var result = new List<PendingChange>(change.Fields.Count);
            var now = DateTime.UtcNow;

            using var txn = conn.BeginTransaction();

            foreach (var (field, newValue) in change.Fields)
            {
                if (UpsertField(conn, change, field, newValue, now) is { } staged)
                    result.Add(staged);
                ReplacePendingFormRefs(conn, change, field, refsByField[field]);
            }
            txn.Commit();

            return result;
        }
        finally { _sem.Release(); }
    }

    private static PendingChange? UpsertField(
        DuckDBConnection conn, PendingChangeUpsert change, string field, JsonElement newValue, DateTime now)
    {
        var id = Guid.NewGuid().ToString();
        var oldRaw = change.OldValues.TryGetValue(field, out var ov) ? ov.GetRawText() : "null";

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO pending_changes
                (id, form_key, plugin, origin, field_path, record_type, old_value, new_value, source, description, changed_at, change_type, parent_cell, placement_group)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (form_key, origin, plugin, field_path) DO UPDATE SET
                new_value   = excluded.new_value,
                changed_at  = excluded.changed_at,
                source      = excluded.source,
                description = excluded.description,
                change_type = excluded.change_type
            RETURNING id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at, change_type, parent_cell, placement_group
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = id });
        cmd.Parameters.Add(new DuckDBParameter { Value = change.FormKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = change.Plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = change.Origin });
        cmd.Parameters.Add(new DuckDBParameter { Value = field });
        cmd.Parameters.Add(new DuckDBParameter { Value = change.RecordType });
        cmd.Parameters.Add(new DuckDBParameter { Value = oldRaw });
        cmd.Parameters.Add(new DuckDBParameter { Value = newValue.GetRawText() });
        cmd.Parameters.Add(new DuckDBParameter { Value = change.Source });
        cmd.Parameters.Add(new DuckDBParameter { Value = change.Description });
        cmd.Parameters.Add(new DuckDBParameter { Value = now });
        cmd.Parameters.Add(new DuckDBParameter { Value = change.ChangeType });
        cmd.Parameters.Add(new DuckDBParameter { Value = change.ParentCell });
        cmd.Parameters.Add(new DuckDBParameter { Value = change.PlacementGroup });

        using var reader = cmd.ExecuteReader();
        return reader.Read() ? ReadChange(reader) : null;
    }

    // Replace pending form refs for this field
    private static void ReplacePendingFormRefs(
        DuckDBConnection conn, PendingChangeUpsert change, string field, IEnumerable<PendingFormRef> fieldRefs)
    {
        using var del = conn.CreateCommand();
        del.CommandText = """
            DELETE FROM pending_form_references
            WHERE source_form_key = $1 AND source_plugin = $2 AND staged_field = $3
            """;
        del.Parameters.Add(new DuckDBParameter { Value = change.FormKey });
        del.Parameters.Add(new DuckDBParameter { Value = change.Plugin });
        del.Parameters.Add(new DuckDBParameter { Value = field });
        del.ExecuteNonQuery();

        foreach (var r in fieldRefs)
        {
            using var ins = conn.CreateCommand();
            ins.CommandText = """
                INSERT INTO pending_form_references
                    (source_form_key, source_plugin, target_form_key, field_path, staged_field, record_type)
                VALUES ($1, $2, $3, $4, $5, $6)
                """;
            ins.Parameters.Add(new DuckDBParameter { Value = change.FormKey });
            ins.Parameters.Add(new DuckDBParameter { Value = change.Plugin });
            ins.Parameters.Add(new DuckDBParameter { Value = r.TargetFormKey });
            ins.Parameters.Add(new DuckDBParameter { Value = r.FieldPath });
            ins.Parameters.Add(new DuckDBParameter { Value = field });
            ins.Parameters.Add(new DuckDBParameter { Value = change.RecordType });
            ins.ExecuteNonQuery();
        }
    }

    public IReadOnlyList<PendingChange> GetChanges(string? plugin = null, string? formKey = null, Guid? memberChangeId = null)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            var (where, paramValues) = BuildFilter(plugin, formKey);
            var changes = DoSelectChanges(conn, where, paramValues);

            // memberChangeId selects the whole component the named change belongs to (ADR-0028),
            // keeping any plugin/formKey filter applied on top.
            if (memberChangeId is not { } id) return changes;

            var component = ComponentOf(conn, id);
            if (component == null) return [];
            var memberIds = component.Select(m => m.Id).ToHashSet();
            return [.. changes.Where(c => memberIds.Contains(c.Id))];
        }
        finally { _sem.Release(); }
    }

    private static List<PendingChange> DoSelectChanges(DuckDBConnection conn, string where, List<object> paramValues)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            SELECT id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at, change_type, parent_cell, placement_group
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

    public int RemoveFieldsWithPrefix(string formKey, string plugin, string prefix)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            using var txn = conn.BeginTransaction();

            using var delRefs = conn.CreateCommand();
            delRefs.CommandText = """
                DELETE FROM pending_form_references
                WHERE source_form_key = $1 AND source_plugin = $2 AND staged_field LIKE $3
                """;
            delRefs.Parameters.Add(new DuckDBParameter { Value = formKey });
            delRefs.Parameters.Add(new DuckDBParameter { Value = plugin });
            delRefs.Parameters.Add(new DuckDBParameter { Value = prefix + "%" });
            delRefs.ExecuteNonQuery();

            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                DELETE FROM pending_changes
                WHERE form_key = $1 AND plugin = $2 AND field_path LIKE $3
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
            cmd.Parameters.Add(new DuckDBParameter { Value = prefix + "%" });
            var count = cmd.ExecuteNonQuery();

            txn.Commit();
            return count;
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

    public (IReadOnlyList<string> Added, IReadOnlyList<string> Removed) GetPendingNativeFormKeyChanges(string plugin)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = $"""
                SELECT form_key, change_type, new_value
                FROM pending_changes
                WHERE plugin = $1
                  AND ((change_type = '{PendingChangeConstants.CreateChangeType}' AND field_path = '{PendingChangeConstants.CreateFieldPath}')
                    OR (change_type = '{PendingChangeConstants.RenumberChangeType}' AND field_path = '{PendingChangeConstants.RenumberFieldPath}'))
                """;
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin });

            var added = new List<string>();
            var removed = new List<string>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
                CollectNativeFormKeyChange(reader, added, removed);
            return (added, removed);
        }
        finally { _sem.Release(); }
    }

    // A pending create contributes its reserved FormKey as an addition; a pending renumber
    // supersedes its pre-renumber FormKey (removed) with the renumber target (added).
    private static void CollectNativeFormKeyChange(DuckDBDataReader reader, List<string> added, List<string> removed)
    {
        var formKey = reader.GetString(0);
        if (reader.GetString(1) == PendingChangeConstants.CreateChangeType)
        {
            added.Add(formKey);
            return;
        }

        removed.Add(formKey);
        using var newValueDoc = JsonDocument.Parse(reader.GetString(2));
        if (newValueDoc.RootElement.GetString() is { } newFormKey)
            added.Add(newFormKey);
    }

    /// <summary>
    /// Reverts a single change on its own. Refuses when the change is entangled with others —
    /// reverting part of a component would leave the rest invalid, so the caller must revert the
    /// whole group. Per ADR-0028 that is a property of the change's *component*, not of a stored
    /// group id: every change now has a group, and a change of one reverts freely.
    /// </summary>
    public RevertChangeResult Revert(Guid changeId)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            var component = ComponentOf(conn, changeId);
            if (component == null) return new RevertChangeResult.NotFound();
            if (component.Count > 1)
                return new RevertChangeResult.GroupOwned(component.Min(m => m.Id));

            using var txn = conn.BeginTransaction();
            DeleteComponent(conn, component);
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
                {
                    refsList.Add((
                        refReader.GetString(0),
                        new PendingFormRef(refReader.GetString(1), refReader.GetString(2), refReader.GetString(3))));
                }
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
                RETURNING id, form_key, plugin, field_path, record_type, old_value, new_value, source, description, changed_at, change_type, parent_cell, placement_group
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
            return [.. AllComponents(conn).Select(Describe)];
        }
        finally { _sem.Release(); }
    }

    private static List<List<PendingChange>> AllComponents(DuckDBConnection conn) =>
        PendingChangeGraph.Components(conn, DoSelectChanges(conn, "", []));

    /// <summary>
    /// The component of the change identified by <paramref name="memberChangeId"/>, or null when no
    /// such change is pending. Groups have no identity of their own (ADR-0028) — any member id
    /// names the whole component.
    /// </summary>
    private static List<PendingChange>? ComponentOf(DuckDBConnection conn, Guid memberChangeId) =>
        AllComponents(conn).FirstOrDefault(c => c.Any(m => m.Id == memberChangeId));

    /// <summary>
    /// Derives a component's ChangeGroup columns from its members (ADR-0028): the id is a member
    /// change id, the operation is the dominant change_type with lifecycle ops beating field_edit,
    /// the description is the originating change's, and created_at is the earliest member's.
    /// </summary>
    private static ChangeGroup Describe(List<PendingChange> members)
    {
        var originating = members
            .OrderBy(m => PendingChangeConstants.IsLifecycle(m.ChangeType) ? 0 : 1)
            .ThenBy(m => m.ChangedAt)
            .ThenBy(m => m.Id)
            .First();

        return new ChangeGroup(
            members.Min(m => m.Id),
            originating.ChangeType,
            originating.Description,
            members.Min(m => m.ChangedAt),
            members.Count,
            members.Select(m => m.Plugin).Distinct(StringComparer.OrdinalIgnoreCase).Count());
    }

    /// <summary>
    /// Reverts the whole component <paramref name="memberChangeId"/> belongs to. False when no such
    /// change is pending.
    /// </summary>
    public bool RevertGroup(Guid memberChangeId)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            var component = ComponentOf(conn, memberChangeId);
            if (component == null) return false;

            using var txn = conn.BeginTransaction();
            DeleteComponent(conn, component);
            txn.Commit();
            return true;
        }
        finally { _sem.Release(); }
    }

    /// <summary>Drops a component's pending rows and the form references staged with them.</summary>
    private static void DeleteComponent(DuckDBConnection conn, List<PendingChange> component)
    {
        foreach (var change in component)
        {
            using var delRef = conn.CreateCommand();
            delRef.CommandText = """
                DELETE FROM pending_form_references
                WHERE source_form_key = $1 AND source_plugin = $2 AND staged_field = $3
                """;
            delRef.Parameters.Add(new DuckDBParameter { Value = change.FormKey });
            delRef.Parameters.Add(new DuckDBParameter { Value = change.Plugin });
            delRef.Parameters.Add(new DuckDBParameter { Value = change.FieldPath });
            delRef.ExecuteNonQuery();

            using var delChange = conn.CreateCommand();
            delChange.CommandText = "DELETE FROM pending_changes WHERE id = $1";
            delChange.Parameters.Add(new DuckDBParameter { Value = change.Id.ToString() });
            delChange.ExecuteNonQuery();
        }
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
            return !reader.Read() ? null : reader.GetString(0);
        }
        finally { _sem.Release(); }
    }

    public ChangeGroup StageChanges(IReadOnlyList<GroupMember> members)
    {
        _sem.Wait();
        try
        {
            var conn = RequireConnection();
            var createdAt = DateTime.UtcNow;

            using var txn = conn.BeginTransaction();

            foreach (var m in members)
            {
                using var ins = conn.CreateCommand();
                ins.CommandText = """
                    INSERT INTO pending_changes
                        (id, form_key, plugin, origin, field_path, record_type, old_value, new_value, source, description, changed_at, change_type, parent_cell, placement_group)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12, $13)
                    ON CONFLICT (form_key, origin, plugin, field_path) DO UPDATE SET
                        new_value   = excluded.new_value,
                        changed_at  = excluded.changed_at,
                        change_type = excluded.change_type,
                        source      = excluded.source
                    """;
                ins.Parameters.Add(new DuckDBParameter { Value = Guid.NewGuid().ToString() });
                ins.Parameters.Add(new DuckDBParameter { Value = m.FormKey });
                ins.Parameters.Add(new DuckDBParameter { Value = m.Plugin });
                ins.Parameters.Add(new DuckDBParameter { Value = m.Origin });
                ins.Parameters.Add(new DuckDBParameter { Value = m.FieldPath });
                ins.Parameters.Add(new DuckDBParameter { Value = m.RecordType });
                ins.Parameters.Add(new DuckDBParameter { Value = m.OldValue.GetRawText() });
                ins.Parameters.Add(new DuckDBParameter { Value = m.NewValue.GetRawText() });
                ins.Parameters.Add(new DuckDBParameter { Value = m.Source });
                ins.Parameters.Add(new DuckDBParameter { Value = createdAt });
                ins.Parameters.Add(new DuckDBParameter { Value = m.ChangeType });
                ins.Parameters.Add(new DuckDBParameter { Value = m.ParentCell });
                ins.Parameters.Add(new DuckDBParameter { Value = m.PlacementGroup });
                ins.ExecuteNonQuery();
            }

            txn.Commit();

            // No group was declared; the grouping is derived from the staged rows (ADR-0028). Return
            // the component the first member landed in — its member change id is the group's id.
            var anchor = FindChange(conn, members[0].FormKey, members[0].Origin, members[0].Plugin, members[0].FieldPath);
            return Describe(ComponentOf(conn, anchor.Id)!);
        }
        finally { _sem.Release(); }
    }

    private static PendingChange FindChange(DuckDBConnection conn, string formKey, string origin, string plugin, string fieldPath) =>
        DoSelectChanges(
            conn,
            " WHERE form_key = $1 AND origin = $2 AND plugin = $3 AND field_path = $4",
            [formKey, origin, plugin, fieldPath]).Single();

    public async Task<SaveGroupResult> ExecuteGroupSaveAsync(
        Guid memberChangeId,
        Func<IReadOnlyDictionary<string, IReadOnlyList<PendingChange>>, Task<IReadOnlyList<(string Plugin, PreparedPluginSave Prepared)>>> prepareAll)
    {
        await _sem.WaitAsync();
        try
        {
            var conn = RequireConnection();
            var pending = ComponentOf(conn, memberChangeId);
            if (pending == null || pending.Count == 0) return new SaveGroupResult.NoChanges();

            var byPlugin = pending
                .GroupBy(c => c.Plugin)
                .ToDictionary(g => g.Key, g => (IReadOnlyList<PendingChange>)[.. g]);

            await using var txn = await conn.BeginTransactionAsync();
            DeleteComponent(conn, pending);

            var prepared = await prepareAll(byPlugin);
            var saveTxn = new SaveTransaction(prepared);
            try
            {
                var results = saveTxn.CommitFiles();
                await txn.CommitAsync();
                saveTxn.Dispose();
                return new SaveGroupResult.Saved(results);
            }
            catch
            {
                // Undoes any files already moved so they match the pending rows this
                // transaction's rollback (on disposal below) is about to restore.
                saveTxn.Rollback();
                saveTxn.Dispose();
                throw;
            }
        }
        finally { _sem.Release(); }
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
        var parentCell = reader.IsDBNull(11) ? null : reader.GetString(11);
        var placementGroup = reader.IsDBNull(12) ? null : reader.GetString(12);

        using var oldDoc = JsonDocument.Parse(oldValueJson);
        var oldValue = oldDoc.RootElement.Clone();
        using var newDoc = JsonDocument.Parse(newValueJson);
        var newValue = newDoc.RootElement.Clone();

        return new PendingChange(id, formKey, plugin, fieldPath, recordType, oldValue, newValue, source, description, changedAt, changeType, parentCell, placementGroup);
    }
}
