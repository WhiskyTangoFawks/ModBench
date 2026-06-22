using System.Data;
using System.Globalization;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;

using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
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

        // Walk VMAD after the per-type loop so both generic and VMAD Object refs land in `refs`
        // before the single form_references flush below.
        DeleteVmadForPlugin(plugin);
        IndexVmad(pluginMod, plugin, refs);

        // Delete stale refs only after both loops succeed — an exception mid-loop now leaves
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

    public VmadData? GetVmad(string formKey, string plugin)
    {
        var scripts = ReadVmadScriptRows(formKey, plugin);
        if (scripts.Count == 0) return null;

        var propRows = ReadVmadPropertyRows(formKey, plugin);
        var propsByScript = propRows
            .GroupBy(r => r.ScriptName, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.OrderBy(r => r.PropertyIndex).ToList(), StringComparer.Ordinal);

        var itemRows = ReadVmadListItemRows(formKey, plugin);
        var itemsByProp = itemRows
            .GroupBy(r => (r.ScriptName, r.PropertyIndex))
            .ToDictionary(g => g.Key, g => g.OrderBy(r => r.ListItemIndex).ToList());

        var scriptData = scripts
            .Select(s =>
            {
                var props = propsByScript.TryGetValue(s.Name, out var rows)
                    ? rows.Select(r =>
                    {
                        var items = itemsByProp.GetValueOrDefault((r.ScriptName, r.PropertyIndex));
                        return new VmadNamedValue(r.PropertyName, MapVmadProperty(r, items));
                    }).ToList()
                    : new List<VmadNamedValue>();
                return new VmadScriptData(s.Name, s.Flags, props);
            })
            .ToList();

        return new VmadData(scriptData);
    }

    private readonly record struct VmadScriptRow(string Name, string Flags);

    private readonly record struct VmadPropertyRow(
        string ScriptName, string PropertyName, int PropertyIndex, string Type, string Flags,
        bool? Bool, int? Int, float? Float, string? String, string? FormKey, short? Alias, string? StructJson);

    private readonly record struct VmadListItemRow(
        string ScriptName, int PropertyIndex, int ListItemIndex, string Type,
        bool? Bool, int? Int, float? Float, string? String, string? FormKey, short? Alias);

    private List<VmadScriptRow> ReadVmadScriptRows(string formKey, string plugin)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = """
            SELECT script_name, flags FROM vmad_scripts
            WHERE form_key = $1 AND plugin = $2
            ORDER BY script_index
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        using var reader = cmd.ExecuteReader();

        var rows = new List<VmadScriptRow>();
        while (reader.Read())
            rows.Add(new VmadScriptRow(reader.GetString(0), reader.GetString(1)));
        return rows;
    }

    private List<VmadPropertyRow> ReadVmadPropertyRows(string formKey, string plugin)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = """
            SELECT script_name, property_name, property_index, type, flags,
                   bool_value, int_value, float_value, string_value, form_key_value, alias_value, struct_json
            FROM vmad_properties
            WHERE form_key = $1 AND plugin = $2
            ORDER BY property_index
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        using var reader = cmd.ExecuteReader();

        var rows = new List<VmadPropertyRow>();
        while (reader.Read())
            rows.Add(new VmadPropertyRow(
                reader.GetString(0), reader.GetString(1), reader.GetInt32(2), reader.GetString(3), reader.GetString(4),
                reader.IsDBNull(5) ? null : reader.GetBoolean(5),
                reader.IsDBNull(6) ? null : reader.GetInt32(6),
                reader.IsDBNull(7) ? null : reader.GetFloat(7),
                reader.IsDBNull(8) ? null : reader.GetString(8),
                reader.IsDBNull(9) ? null : reader.GetString(9),
                reader.IsDBNull(10) ? null : reader.GetInt16(10),
                reader.IsDBNull(11) ? null : reader.GetString(11)));
        return rows;
    }

    private List<VmadListItemRow> ReadVmadListItemRows(string formKey, string plugin)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = """
            SELECT script_name, property_index, list_item_index, type,
                   bool_value, int_value, float_value, string_value, form_key_value, alias_value
            FROM vmad_property_list_items
            WHERE form_key = $1 AND plugin = $2
            ORDER BY property_index, list_item_index
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        using var reader = cmd.ExecuteReader();

        var rows = new List<VmadListItemRow>();
        while (reader.Read())
            rows.Add(new VmadListItemRow(
                reader.GetString(0), reader.GetInt32(1), reader.GetInt32(2), reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetBoolean(4),
                reader.IsDBNull(5) ? null : reader.GetInt32(5),
                reader.IsDBNull(6) ? null : reader.GetFloat(6),
                reader.IsDBNull(7) ? null : reader.GetString(7),
                reader.IsDBNull(8) ? null : reader.GetString(8),
                reader.IsDBNull(9) ? null : reader.GetInt16(9)));
        return rows;
    }

    private static VmadPropertyValue MapVmadProperty(VmadPropertyRow r, List<VmadListItemRow>? items) => r.Type switch
    {
        "Bool" => new VmadPropertyValue(r.Type, r.Flags, r.Bool),
        "Int" => new VmadPropertyValue(r.Type, r.Flags, r.Int),
        "Float" => new VmadPropertyValue(r.Type, r.Flags, r.Float),
        "String" => new VmadPropertyValue(r.Type, r.Flags, r.String),
        "Object" => new VmadPropertyValue(r.Type, r.Flags, r.FormKey, r.Alias),
        "ArrayOfBool" or "ArrayOfInt" or "ArrayOfFloat" or "ArrayOfString" or "ArrayOfObject" =>
            new VmadPropertyValue(r.Type, r.Flags, null, ListItems: MapVmadItems(items)),
        "Struct" => new VmadPropertyValue(r.Type, r.Flags, null, Members: MapStructMembers(r.StructJson)),
        "ArrayOfStruct" => new VmadPropertyValue(r.Type, r.Flags, null, StructList: MapStructList(r.StructJson)),
        _ => new VmadPropertyValue(r.Type, r.Flags, null),
    };

    private static List<VmadNamedValue>? MapStructMembers(string? structJson)
    {
        if (structJson is null) return null;
        // A Struct's fields live inside a single unnamed ScriptEntry wrapper in the binary format,
        // so flatten that wrapper to surface struct fields directly as named members.
        return VmadJson.DeserializeStruct(structJson)
            .SelectMany(e => e.Properties)
            .Select(n => new VmadNamedValue(n.Name, MapNode(n)))
            .ToList();
    }

    private static List<IReadOnlyList<VmadNamedValue>>? MapStructList(string? structJson)
    {
        if (structJson is null) return null;
        return VmadJson.DeserializeStructList(structJson)
            .Select(inst => (IReadOnlyList<VmadNamedValue>)MapNodes(inst.Members))
            .ToList();
    }

    private static List<VmadNamedValue> MapNodes(VmadPropertyNode[] nodes) =>
        nodes.Select(n => new VmadNamedValue(n.Name, MapNode(n))).ToList();

    private static VmadPropertyValue MapNode(VmadPropertyNode n) => n.Type switch
    {
        "Bool" => new VmadPropertyValue(n.Type, n.Flags, n.BoolValue),
        "Int" => new VmadPropertyValue(n.Type, n.Flags, n.IntValue),
        "Float" => new VmadPropertyValue(n.Type, n.Flags, n.FloatValue),
        "String" => new VmadPropertyValue(n.Type, n.Flags, n.StringValue),
        "Object" => new VmadPropertyValue(n.Type, n.Flags, n.FormKeyValue, n.AliasValue),
        _ => new VmadPropertyValue(n.Type, n.Flags, null),
    };

    // Array elements carry no per-element flags (flags live at the property level only), hence "".
    private static List<VmadPropertyValue> MapVmadItems(List<VmadListItemRow>? items) =>
        items is null
            ? []
            : items.Select(i => i.Type switch
            {
                "ArrayOfBool" => new VmadPropertyValue("Bool", "", i.Bool),
                "ArrayOfInt" => new VmadPropertyValue("Int", "", i.Int),
                "ArrayOfFloat" => new VmadPropertyValue("Float", "", i.Float),
                "ArrayOfString" => new VmadPropertyValue("String", "", i.String),
                "ArrayOfObject" => new VmadPropertyValue("Object", "", i.FormKey, i.Alias),
                _ => new VmadPropertyValue(i.Type, "", null),
            }).ToList();

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

    private void IndexVmad(IModGetter pluginMod, string plugin, List<FormRef> refs)
    {
        using var scriptAppender = _connection.CreateAppender("vmad_scripts");
        using var propAppender = _connection.CreateAppender("vmad_properties");
        using var itemAppender = _connection.CreateAppender("vmad_property_list_items");
        var indexer = new VmadIndexer(scriptAppender, propAppender, itemAppender, refs, _logger);

        var vmadCount = 0;
        foreach (var record in pluginMod.EnumerateMajorRecords<IHaveVirtualMachineAdapterGetter>(
                     throwIfUnknown: false))
        {
            if (record.VirtualMachineAdapter is not { } vmad) continue;
            var recordType = ResolveRecordType(record);
            try
            {
                indexer.IndexRecord(record.FormKey.ToString(), plugin, recordType, vmad);
                vmadCount++;
            }
            catch (NotImplementedException ex)
            {
                _logger.LogWarning(ex,
                    "Skipping VMAD for {FormKey} — property type not implemented in Mutagen",
                    record.FormKey);
            }
        }
        _logger.LogInformation("Indexed VMAD for {Count} records in {Plugin}", vmadCount, plugin);
    }

    private void DeleteVmadForPlugin(string plugin)
    {
        foreach (var table in (string[])["vmad_scripts", "vmad_properties", "vmad_property_list_items"])
            DeleteExisting(table, plugin);
    }

    private string ResolveRecordType(IMajorRecordGetter record)
    {
        var schemas = RequireSchemas();
        foreach (var (tableName, schema) in schemas)
            if (schema.RecordType.IsInstanceOfType(record))
                return tableName;
        return record.GetType().Name.ToLowerInvariant();
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
