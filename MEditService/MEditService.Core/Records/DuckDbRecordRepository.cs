using System.Data;
using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using DuckDB.NET.Data;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

public sealed class DuckDbRecordRepository : IRecordRepository
{
    private readonly ISchemaReflector _schemaReflector;
    private readonly ITableDdlBuilder _ddlBuilder;
    private readonly IFieldMetadataMapper _metadataMapper;
    private readonly ILogger _logger;
    private readonly DuckDBConnection _connection;
    private IReadOnlyDictionary<string, RecordTableSchema>? _schemas;
    private bool _disposed;

    public DuckDbRecordRepository(
        ISchemaReflector schemaReflector,
        ITableDdlBuilder ddlBuilder,
        IFieldMetadataMapper metadataMapper,
        ILogger? logger = null)
    {
        _schemaReflector = schemaReflector;
        _ddlBuilder = ddlBuilder;
        _metadataMapper = metadataMapper;
        _logger = logger ?? NullLogger.Instance;
        _connection = new DuckDBConnection("DataSource=:memory:");
        _connection.Open();
    }

    public void Initialize(GameRelease release)
    {
        _ddlBuilder.CreateTables(_connection, release);
        _schemas = _schemaReflector.GetSchemas(release);
    }

    // --- Indexing (absorbed from RecordIndexer) ---

    public void Index(IModGetter mod, int loadOrderIndex)
    {
        var schemas = RequireSchemas();
        var plugin = mod.ModKey.FileName.ToString();

        foreach (var (tableName, schema) in schemas)
        {
            List<IMajorRecordGetter> records;
            try
            {
                records = mod.EnumerateMajorRecords(schema.RecordType, throwIfUnknown: false).ToList();
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
        var (where, paramValues) = BuildWhere(plugin, search);

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

    public RecordDetail? GetRecord(string tableName, RecordTableSchema schema, string formKey, string? plugin, bool winnerOnly)
    {
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
        return reader.Read() ? ReadDetail(reader, schema) : null;
    }

    public IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, RecordTableSchema schema, string formKey)
    {
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
        while (reader.Read())
            list.Add(ReadDetail(reader, schema));
        return list;
    }

    public int CountRecordsForPlugin(string tableName, string plugin)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM \"{tableName}\" WHERE plugin = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
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

        var (where, paramValues) = BuildWhere(plugin, search);
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

    private static RecordSummary ReadSummary(IDataReader reader) =>
        new(reader.GetString(0), reader.GetString(1), reader.GetInt32(2),
            reader.GetBoolean(3), reader.IsDBNull(4) ? null : reader.GetString(4));

    private RecordDetail ReadDetail(IDataReader reader, RecordTableSchema schema)
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
            object? value = reader.IsDBNull(5 + i) ? null : reader.GetValue(5 + i);
            fields.Add(new FieldValue(_metadataMapper.Map(col), value));
        }

        return new RecordDetail(formKey, plugin, loadOrderIndex, isWinner, editorId, fields);
    }

    private static string ColumnList(RecordTableSchema schema) =>
        schema.RecordColumns.Count == 0
            ? ""
            : ", " + string.Join(", ", schema.RecordColumns.Select(c => $"\"{c.Name}\""));

    private static (string where, List<string> paramValues) BuildWhere(string? plugin, string? search)
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

    private void Execute(string sql)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static void AppendTyped(IDuckDBAppenderRow row, object? value, string duckDbType)
    {
        if (value == null) { row.AppendNullValue(); return; }
        switch (duckDbType)
        {
            case "BOOLEAN": row.AppendValue((bool?)Convert.ToBoolean(value)); break;
            case "INTEGER": row.AppendValue((int?)Convert.ToInt32(value)); break;
            case "BIGINT":  row.AppendValue((long?)Convert.ToInt64(value)); break;
            case "FLOAT":   row.AppendValue((float?)Convert.ToSingle(value)); break;
            case "DOUBLE":  row.AppendValue((double?)Convert.ToDouble(value)); break;
            case "VARCHAR": row.AppendValue(value.ToString() ?? ""); break;
            default:        row.AppendValue(JsonSerializer.Serialize(value)); break;
        }
    }

    private IReadOnlyDictionary<string, RecordTableSchema> RequireSchemas() =>
        _schemas ?? throw new InvalidOperationException("Call Initialize before using the repository.");

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _connection.Dispose();
    }
}
