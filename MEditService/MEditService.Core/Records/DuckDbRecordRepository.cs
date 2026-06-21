using System.Data;
using System.Globalization;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;

using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

public sealed class DuckDbRecordRepository : IRecordRepository
{
    private readonly ISchemaReflector _schemaReflector;
    private readonly ITableDdlBuilder _ddlBuilder;
    private readonly ILogger _logger;
    private readonly DuckDBConnection _connection;
    private IReadOnlyDictionary<string, RecordTableSchema>? _schemas;
    private bool _filterActive;

    public DuckDBConnection Connection => _connection;

    public DuckDbRecordRepository(
        ISchemaReflector schemaReflector,
        ITableDdlBuilder ddlBuilder,
        ILogger logger)
    {
        _schemaReflector = schemaReflector;
        _ddlBuilder = ddlBuilder;
        _logger = logger;
        _connection = new DuckDBConnection("DataSource=:memory:");
        _connection.Open();
    }

    public void Initialize(GameRelease release)
    {
        _ddlBuilder.CreateTables(_connection, release);
        _schemas = _schemaReflector.GetSchemas(release);
    }

    // --- Indexing (absorbed from RecordIndexer) ---

    public void Index(IModGetter pluginMod, int loadOrderIndex)
    {
        var schemas = RequireSchemas();
        var plugin = pluginMod.ModKey.FileName.ToString();

        var refs = new List<FormRef>();

        foreach (var (tableName, schema) in schemas)
        {
            List<IMajorRecordGetter> records;
            try
            {
                records = pluginMod.EnumerateMajorRecords(schema.RecordType, throwIfUnknown: false).ToList();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to enumerate {RecordType} records from {Plugin}", tableName, plugin);
                throw;
            }

            if (records.Count == 0) continue;

            _logger.LogDebug("Appending {Count} {RecordType} records from {Plugin}", records.Count, tableName, plugin);

            DeleteExisting(tableName, plugin);

            using var appender = _connection.CreateAppender(tableName);
            foreach (var record in records)
            {
                try
                {
                    var row = appender.CreateRow();
                    row.AppendValue(record.FormKey.ToString());
                    row.AppendValue(plugin);
                    row.AppendValue((int?)loadOrderIndex);
                    row.AppendValue((bool?)false);
                    if (record.EditorID is { } edId)
                        row.AppendValue(edId);
                    else
                        row.AppendNullValue();

                    foreach (var col in schema.RecordColumns)
                        AppendTyped(row, col.Extract(record), col.DuckDbType);

                    row.EndRow();
                    CollectFormRefs(refs, record, tableName, schema);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex,
                        "Failed to append {RecordType} record {FormKey} ({EditorID}) from {Plugin}",
                        tableName, record.FormKey, record.EditorID, plugin);
                    throw;
                }
            }
        }

        // Delete stale refs only after the loop succeeds — an exception mid-loop now leaves
        // existing form_references intact rather than permanently empty.
        DeleteFormReferencesForPlugin(plugin);
        if (refs.Count > 0)
        {
            using var refAppender = _connection.CreateAppender("form_references");
            foreach (var r in refs)
            {
                var row = refAppender.CreateRow();
                row.AppendValue(r.SourceFormKey);
                row.AppendValue(plugin);
                row.AppendValue(r.TargetFormKey);
                row.AppendValue(r.FieldPath);
                row.AppendValue(r.RecordType);
                if (r.EditorId is { } eid)
                    row.AppendValue(eid);
                else
                    row.AppendNullValue();
                row.EndRow();
            }
        }
    }

    public void UpdateWinners()
    {
        var schemas = RequireSchemas();
        foreach (var tableName in schemas.Keys)
        {
            Execute($"""
                UPDATE "{tableName}"
                SET is_winner = (load_order_idx = (
                    SELECT MAX(t2.load_order_idx) FROM "{tableName}" t2
                    WHERE t2.form_key = "{tableName}".form_key
                ))
                """);
        }
    }

    // --- Queries (absorbed from RecordQueryService, with DuckDBParameter throughout) ---

    public PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset)
    {
        var (where, paramValues) = BuildWhere(plugin, search, _filterActive);

        var countSql = $"SELECT COUNT(*) FROM \"{tableName}\"{where}";
        using var countCmd = _connection.CreateCommand();
        countCmd.CommandText = countSql;
        AddParams(countCmd, paramValues);
        var total = (long)countCmd.ExecuteScalar()!;

        var dataSql = $"""
            SELECT form_key, plugin, load_order_idx, is_winner, editor_id
            FROM "{tableName}"{where}
            ORDER BY editor_id
            LIMIT {limit} OFFSET {offset}
            """;
        using var dataCmd = _connection.CreateCommand();
        dataCmd.CommandText = dataSql;
        AddParams(dataCmd, paramValues);

        var items = new List<RecordSummary>();
        using var reader = dataCmd.ExecuteReader();
        while (reader.Read())
            items.Add(ReadSummary(reader));

        return new PagedResult<RecordSummary>(items, (int)total);
    }

    public RecordDetail? GetRecord(string tableName, string formKey, string? plugin, bool winnerOnly)
    {
        var schema = RequireSchemas()[tableName];
        var conditions = new List<string> { "form_key = $1" };
        var values = new List<string> { formKey };

        if (winnerOnly) conditions.Add("is_winner = true");
        if (plugin != null)
        {
            conditions.Add($"plugin = ${values.Count + 1}");
            values.Add(plugin);
        }

        var where = " WHERE " + string.Join(" AND ", conditions);
        var sql = $"""
            SELECT form_key, plugin, load_order_idx, is_winner, editor_id{ColumnList(schema)}
            FROM "{tableName}"{where}
            LIMIT 1
            """;

        using var cmd = _connection.CreateCommand();
        cmd.CommandText = sql;
        AddParams(cmd, values);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;
        var cache = new Dictionary<string, string?>();
        return ReadDetail(reader, schema, fk =>
        {
            if (cache.TryGetValue(fk, out var t)) return t;
            var resolved = FindRecordType(fk);
            cache[fk] = resolved;
            return resolved;
        });
    }

    public IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, string formKey)
    {
        var schema = RequireSchemas()[tableName];
        var sql = $"""
            SELECT form_key, plugin, load_order_idx, is_winner, editor_id{ColumnList(schema)}
            FROM "{tableName}"
            WHERE form_key = $1
            ORDER BY load_order_idx
            """;
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        using var reader = cmd.ExecuteReader();

        var list = new List<RecordDetail>();
        var cache = new Dictionary<string, string?>();
        while (reader.Read())
            list.Add(ReadDetail(reader, schema, fk =>
            {
                if (cache.TryGetValue(fk, out var t)) return t;
                var resolved = FindRecordType(fk);
                cache[fk] = resolved;
                return resolved;
            }));
        return list;
    }

    public int CountRecordsForPlugin(string tableName, string plugin)
    {
        var (where, paramValues) = BuildWhere(plugin, null, _filterActive);
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM \"{tableName}\"{where}";
        AddParams(cmd, paramValues);
        return (int)(long)cmd.ExecuteScalar()!;
    }

    public string? FindRecordType(string formKey)
    {
        var schemas = RequireSchemas();
        foreach (var tableName in schemas.Keys)
        {
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = $"SELECT 1 FROM \"{tableName}\" WHERE form_key = $1 LIMIT 1";
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            if (cmd.ExecuteScalar() != null) return tableName;
        }
        return null;
    }

    public PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> tableNames, string? plugin, string? search, int limit, int offset)
    {
        if (tableNames.Count == 0)
            return new PagedResult<RecordSummary>([], 0);

        var (where, paramValues) = BuildWhere(plugin, search, _filterActive);
        const string cols = "form_key, plugin, load_order_idx, is_winner, editor_id";
        var union = string.Join("\nUNION ALL\n",
            tableNames.Select(t => $"SELECT {cols} FROM \"{t}\"{where}"));

        using var countCmd = _connection.CreateCommand();
        countCmd.CommandText = $"SELECT COUNT(*) FROM ({union})";
        AddParams(countCmd, paramValues);
        var total = (long)countCmd.ExecuteScalar()!;

        using var dataCmd = _connection.CreateCommand();
        dataCmd.CommandText = $"""
            SELECT {cols} FROM ({union})
            ORDER BY editor_id
            LIMIT {limit} OFFSET {offset}
            """;
        AddParams(dataCmd, paramValues);

        var items = new List<RecordSummary>();
        using var reader = dataCmd.ExecuteReader();
        while (reader.Read())
            items.Add(ReadSummary(reader));

        return new PagedResult<RecordSummary>(items, (int)total);
    }

    // --- Helpers ---

    private static RecordSummary ReadSummary(DuckDBDataReader reader) =>
        new(reader.GetString(0), reader.GetString(1), reader.GetInt32(2),
            reader.GetBoolean(3), reader.IsDBNull(4) ? null : reader.GetString(4));

    private static RecordDetail ReadDetail(DuckDBDataReader reader, RecordTableSchema schema, Func<string, string?> getRecordType)
    {
        var formKey = reader.GetString(0);
        var plugin = reader.GetString(1);
        var loadOrderIndex = reader.GetInt32(2);
        var isWinner = reader.GetBoolean(3);
        var editorId = reader.IsDBNull(4) ? null : reader.GetString(4);

        var fields = new List<FieldValue>();
        for (int i = 0; i < schema.RecordColumns.Count; i++)
        {
            var col = schema.RecordColumns[i];
            object? value;
            if (!reader.IsDBNull(5 + i) && (col.IsArray || col.SubFields != null))
            {
                value = JsonSerializer.Deserialize<JsonElement>(reader.GetString(5 + i));
            }
            else
            {
                value = reader.IsDBNull(5 + i) ? null : reader.GetValue(5 + i);
            }
            // Bitmask flag values can exceed 2^53 (e.g. FO4 Race.Flag bits 53/54). Surface them as
            // decimal strings so they survive JSON round-tripping without IEEE 754 precision loss.
            if (value != null && col.IsBitmask)
                value = Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
            var meta = col.ToFieldMetadata();
            fields.Add(new FieldValue(meta, value, CheckErrorBuilder.Build(meta, value, getRecordType)));
        }

        return new RecordDetail(formKey, plugin, loadOrderIndex, isWinner, editorId, fields);
    }

    internal static string ColumnList(RecordTableSchema schema) =>
        schema.RecordColumns.Count == 0
            ? ""
            : ", " + string.Join(", ", schema.RecordColumns.Select(c => $"\"{c.Name}\""));

    private static (string where, List<string> paramValues) BuildWhere(string? plugin, string? search, bool filterActive = false)
    {
        var conditions = new List<string>();
        var values = new List<string>();

        if (plugin != null)
        {
            conditions.Add($"plugin = ${values.Count + 1}");
            values.Add(plugin);
        }
        if (search != null)
        {
            conditions.Add($"editor_id ILIKE ${values.Count + 1}");
            values.Add($"%{search}%");
        }
        if (filterActive)
            conditions.Add("form_key IN (SELECT form_key FROM _filter)");

        var where = conditions.Count > 0 ? " WHERE " + string.Join(" AND ", conditions) : "";
        return (where, values);
    }

    private static void AddParams(DuckDBCommand cmd, IEnumerable<string> values)
    {
        foreach (var v in values)
            cmd.Parameters.Add(new DuckDBParameter { Value = v });
    }

    private void DeleteExisting(string tableName, string plugin)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = $"DELETE FROM \"{tableName}\" WHERE plugin = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.ExecuteNonQuery();
    }

    private void DeleteFormReferencesForPlugin(string plugin)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = "DELETE FROM form_references WHERE source_plugin = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.ExecuteNonQuery();
    }

    private static void CollectFormRefs(
        List<FormRef> refs,
        IMajorRecordGetter record,
        string tableName,
        RecordTableSchema schema)
    {
        var sourceFormKey = record.FormKey.ToString();
        var sourceEditorId = record.EditorID;
        foreach (var col in schema.RecordColumns)
        {
            FormRefPathBuilder.Walk(col, c => c.Extract(record), (path, fk) =>
                refs.Add(new FormRef(sourceFormKey, fk, path, tableName, sourceEditorId)));
        }
    }

    private record struct FormRef(
        string SourceFormKey,
        string TargetFormKey,
        string FieldPath,
        string RecordType,
        string? EditorId);

    private void Execute(string sql)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    internal static void AppendTyped(IDuckDBAppenderRow row, object? value, string duckDbType)
    {
        if (value == null) { row.AppendNullValue(); return; }
        switch (duckDbType)
        {
            case "BOOLEAN": row.AppendValue((bool?)Convert.ToBoolean(value, CultureInfo.InvariantCulture)); break;
            case "INTEGER": row.AppendValue((int?)Convert.ToInt32(value, CultureInfo.InvariantCulture)); break;
            case "BIGINT": row.AppendValue((long?)Convert.ToInt64(value, CultureInfo.InvariantCulture)); break;
            case "FLOAT": row.AppendValue((float?)Convert.ToSingle(value, CultureInfo.InvariantCulture)); break;
            case "DOUBLE": row.AppendValue((double?)Convert.ToDouble(value, CultureInfo.InvariantCulture)); break;
            case "VARCHAR": row.AppendValue(value.ToString()); break;
        }
    }

    private IReadOnlyDictionary<string, RecordTableSchema> RequireSchemas() =>
        _schemas ?? throw new InvalidOperationException("Call Initialize before using the repository.");

    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey)
    {
        var sql = """
            SELECT fr.source_form_key, fr.source_plugin, fr.field_path, fr.record_type, fr.editor_id
            FROM form_references fr
            WHERE fr.target_form_key = $1
              AND NOT EXISTS (
                SELECT 1 FROM pending_changes pc
                WHERE pc.form_key = fr.source_form_key
                  AND pc.plugin   = fr.source_plugin
                  AND (
                    fr.field_path = pc.field_path
                    OR fr.field_path LIKE pc.field_path || '[%'
                  )
              )

            UNION ALL

            SELECT pfr.source_form_key, pfr.source_plugin, pfr.field_path, pfr.record_type, NULL
            FROM pending_form_references pfr
            WHERE pfr.target_form_key = $1
            """;

        using var cmd = _connection.CreateCommand();
        cmd.CommandText = sql;
        AddParams(cmd, [targetFormKey]);

        var results = new List<ReferenceResult>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            results.Add(new ReferenceResult(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4)));
        return results;
    }

    public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames)
    {
        var tables = tableNames.ToList();
        if (tables.Count == 0 || !_filterActive)
            return new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var union = string.Join("\nUNION ALL\n",
            tables.Select(t => $"SELECT plugin FROM \"{t}\" WHERE form_key IN (SELECT form_key FROM _filter)"));

        using var cmd = _connection.CreateCommand();
        cmd.CommandText = $"SELECT DISTINCT plugin FROM ({union})";
        using var reader = cmd.ExecuteReader();

        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (reader.Read())
            result.Add(reader.GetString(0));
        return result;
    }

    public void SetFilter(string? sql)
    {
        if (sql is null)
        {
            _filterActive = false;
            return;
        }

        using var probeCmd = _connection.CreateCommand();
        probeCmd.CommandText = $"SELECT * FROM ({sql}) __probe LIMIT 0";
        using var probeReader = probeCmd.ExecuteReader();
        bool hasFormKey = Enumerable.Range(0, probeReader.FieldCount)
            .Any(i => string.Equals(probeReader.GetName(i), "form_key", StringComparison.OrdinalIgnoreCase));

        if (!hasFormKey)
            throw new ArgumentException("Filter SQL must return a form_key column");

        Execute($"CREATE OR REPLACE TABLE _filter AS ({sql})");
        _filterActive = true;
    }

    public void Dispose() => _connection.Dispose();
}
