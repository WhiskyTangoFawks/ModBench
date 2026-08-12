using System.Data;
using System.Globalization;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Core.Session;
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
    private IReadOnlyDictionary<string, RecordTableSchema>? _schemas;
    private readonly PlacementWalker _placementWalker = new();
    private static readonly string[] PlacedTableNames = ["refr", "achr"];
    private bool _filterActive;
    // #165: resolved once at Initialize (this repository is one game/session for its whole
    // lifetime) so GetConditions can decode a Number-category parameter's enum member name without
    // re-resolving per call. Null for a game with no condition codec — same "fails to nothing, not
    // silently wrong" fallback ConditionCodecRegistry.For already establishes elsewhere.
    private IConditionCodec? _conditionCodec;

    public DuckDBConnection Connection { get; }

    public DuckDbRecordRepository(
        ISchemaReflector schemaReflector,
        ITableDdlBuilder ddlBuilder,
        ILogger logger)
    {
        _schemaReflector = schemaReflector;
        _ddlBuilder = ddlBuilder;
        _logger = logger;
        Connection = new DuckDBConnection("DataSource=:memory:");
        Connection.Open();
    }

    public void Initialize(GameRelease release)
    {
        _ddlBuilder.CreateTables(Connection, release);
        _schemas = _schemaReflector.GetSchemas(release);
        _conditionCodec = ConditionCodecRegistry.For(release.ToCategory());
    }

    // --- Indexing (absorbed from RecordIndexer) ---

    // origin (#271 / ADR-0036): the mod folder that provided this physical file, or a reserved
    // PluginOrigin value. Required (#275) — threaded into every per-plugin delete/upsert/append
    // below so a plugin is identified by (origin, plugin) together, not filename alone: two
    // plugins sharing a filename but differing in origin no longer collide.
    public void Index(IModGetter pluginMod, int loadOrderIndex, bool participates, string origin)
    {
        var schemas = RequireSchemas();
        var plugin = pluginMod.ModKey.FileName.ToString();

        var refs = new List<FormRef>();
        var lookupRows = new List<(string FormKey, string RecordType, string? EditorId)>();

        // One transaction for the whole reindex so a throw partway leaves the prior committed
        // read model intact rather than a partial snapshot. DuckDB appenders enroll in the active
        // transaction, so deletes and appender flushes roll back together on Dispose-without-Commit.
        using var tx = Connection.BeginTransaction();

        // #267: one `plugins` row per indexed plugin — UpdateWinners() joins against it so a
        // non-participating plugin's rows never win regardless of load_order_idx.
        UpsertPluginParticipation(plugin, origin, loadOrderIndex, participates);

        foreach (var (tableName, schema) in schemas)
        {
            // The header table is never a major-record type (ModHeader has no FormKey/EditorID) —
            // IndexRecordTable's EnumerateMajorRecords call assumes one, so it's indexed separately,
            // and header rows never enter form_lookup for the same reason.
            if (tableName == "header") continue;
            IndexRecordTable(tableName, schema, pluginMod, plugin, origin, loadOrderIndex, refs, lookupRows);
        }

        // Walk VMAD after the per-type loop so both generic and VMAD Object refs land in `refs`
        // before the single form_references flush below.
        // #272 / ADR-0036: VMAD/conditions/form_lookup/header now all carry origin too, scoped the
        // same way as every other table above — closes the gap #271 left open. Header's own delete
        // step is in IndexHeader below; its write side already carried origin since #271.
        DeleteVmadForPlugin(plugin, origin);
        IndexVmad(pluginMod, plugin, origin, refs);

        DeleteConditionsForPlugin(plugin, origin);
        IndexConditions(pluginMod, plugin, origin, refs);

        IndexPlacement(pluginMod, plugin, origin);

        IndexHeader(pluginMod, plugin, origin, loadOrderIndex, schemas);

        // Clear this plugin's stale refs, then rebuild from the refs gathered across both passes.
        DeleteFormReferencesForPlugin(plugin, origin);
        if (refs.Count > 0)
        {
            using var refAppender = Connection.CreateAppender("form_references");
            foreach (var r in refs)
            {
                var row = refAppender.CreateRow();
                row.AppendValue(r.SourceFormKey);
                row.AppendValue(plugin);
                row.AppendValue(origin);
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

        // ADR-0031: one form_lookup row per indexed record, populated in this same pass — no
        // second indexing pass over the plugin.
        DeleteExistingForOrigin("form_lookup", plugin, origin);
        if (lookupRows.Count > 0)
        {
            using var lookupAppender = Connection.CreateAppender("form_lookup");
            foreach (var (formKey, recordType, editorId) in lookupRows)
            {
                var row = lookupAppender.CreateRow();
                row.AppendValue(formKey);
                row.AppendValue(plugin);
                row.AppendValue(origin);
                row.AppendValue(recordType);
                if (editorId is { } eid)
                    row.AppendValue(eid);
                else
                    row.AppendNullValue();
                row.AppendValue((int?)loadOrderIndex);
                row.AppendValue((bool?)false);
                row.EndRow();
            }
        }

        tx.Commit();
    }

    private void IndexRecordTable(
        string tableName, RecordTableSchema schema, IModGetter pluginMod,
        string plugin, string origin, int loadOrderIndex, List<FormRef> refs,
        List<(string FormKey, string RecordType, string? EditorId)> lookupRows)
    {
        List<IMajorRecordGetter> records;
        try
        {
            records = [.. pluginMod.EnumerateMajorRecords(schema.RecordType, throwIfUnknown: false)];
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to enumerate {RecordType} records from {Plugin}", tableName, plugin);
            throw;
        }

        if (records.Count == 0) return;

        _logger.LogDebug("Appending {Count} {RecordType} records from {Plugin}", records.Count, tableName, plugin);

        DeleteExistingForOrigin(tableName, plugin, origin);

        using var appender = Connection.CreateAppender(tableName);
        foreach (var record in records)
        {
            try
            {
                var row = appender.CreateRow();
                row.AppendValue(record.FormKey.ToString());
                row.AppendValue(plugin);
                row.AppendValue(origin);
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
                lookupRows.Add((record.FormKey.ToString(), tableName, record.EditorID));
                _logger.LogTrace("Appended {RecordType} record {FormKey} ({EditorID}) from {Plugin}",
                    tableName, record.FormKey, record.EditorID, plugin);
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

    // #267 / ADR-0035: one row per indexed plugin, upserted every Index() call. UpdateWinners()
    // joins record tables against it by plugin name rather than widening every reflected table
    // with its own participates column.
    private void UpsertPluginParticipation(string plugin, string origin, int loadOrderIndex, bool participates)
    {
        DeleteExistingForOrigin("plugins", plugin, origin);
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = "INSERT INTO plugins (plugin, origin, load_order_idx, participates) VALUES ($1, $2, $3, $4)";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        cmd.Parameters.Add(new DuckDBParameter { Value = loadOrderIndex });
        cmd.Parameters.Add(new DuckDBParameter { Value = participates });
        cmd.ExecuteNonQuery();
    }

    public void SetPluginParticipation(string plugin, bool participates, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = "UPDATE plugins SET participates = $3 WHERE plugin = $1 AND origin = $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        cmd.Parameters.Add(new DuckDBParameter { Value = participates });
        cmd.ExecuteNonQuery();
    }

    public void UpdateWinners()
    {
        var schemas = RequireSchemas();
        foreach (var tableName in schemas.Keys)
        {
            // #271 / ADR-0036: joined on (plugin, origin) together — two plugins sharing a filename
            // but differing in origin are distinct participants, each judged on its own load_order_idx
            // and participation, not folded into one MAX() bucket by filename alone.
            Execute($"""
                UPDATE "{tableName}"
                SET is_winner = (
                    load_order_idx = (
                        SELECT MAX(t2.load_order_idx) FROM "{tableName}" t2
                        JOIN plugins p2 ON p2.plugin = t2.plugin AND p2.origin = t2.origin AND p2.participates
                        WHERE t2.form_key = "{tableName}".form_key
                    )
                    AND EXISTS (
                        SELECT 1 FROM plugins p1
                        WHERE p1.plugin = "{tableName}".plugin AND p1.origin = "{tableName}".origin AND p1.participates
                    )
                )
                """);
        }

        // form_lookup isn't a reflected schema table, so it needs its own winner sweep — same
        // shape as every other table's, so ResolveFormKey's EditorID reflects the winning override
        // like every other resolved field, not a winner-agnostic special case (ADR-0031).
        // #272 / ADR-0036: joined on (plugin, origin) together, same as the reflected-table sweep
        // above — two plugins sharing a filename but differing in origin are distinct participants.
        Execute("""
            UPDATE form_lookup
            SET is_winner = (
                load_order_idx = (
                    SELECT MAX(t2.load_order_idx) FROM form_lookup t2
                    JOIN plugins p2 ON p2.plugin = t2.plugin AND p2.origin = t2.origin AND p2.participates
                    WHERE t2.form_key = form_lookup.form_key
                )
                AND EXISTS (
                    SELECT 1 FROM plugins p1
                    WHERE p1.plugin = form_lookup.plugin AND p1.origin = form_lookup.origin AND p1.participates
                )
            )
            """);
    }

    // --- Queries (absorbed from RecordQueryService, with DuckDBParameter throughout) ---

    public PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset)
    {
        var (where, paramValues) = BuildWhere(plugin, search, _filterActive);

        var countSql = $"SELECT COUNT(*) FROM \"{tableName}\"{where}";
        using var countCmd = Connection.CreateCommand();
        countCmd.CommandText = countSql;
        AddParams(countCmd, paramValues);
        var total = (long)countCmd.ExecuteScalar()!;

        var dataSql = $"""
            SELECT form_key, plugin, load_order_idx, is_winner, editor_id
            FROM "{tableName}"{where}
            ORDER BY editor_id
            LIMIT {limit} OFFSET {offset}
            """;
        using var dataCmd = Connection.CreateCommand();
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
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id{ColumnList(schema)}
            FROM "{tableName}"{where}
            LIMIT 1
            """;

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        AddParams(cmd, values);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;
        var cache = new Dictionary<string, RecordLookupEntry?>();
        return ReadDetail(reader, schema, fk =>
        {
            if (cache.TryGetValue(fk, out var t)) return t;
            var resolved = ResolveFormKey(fk);
            cache[fk] = resolved;
            return resolved;
        });
    }

    public IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, string formKey)
    {
        var schema = RequireSchemas()[tableName];
        var sql = $"""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id{ColumnList(schema)}
            FROM "{tableName}"
            WHERE form_key = $1
            ORDER BY load_order_idx
            """;
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        using var reader = cmd.ExecuteReader();

        var list = new List<RecordDetail>();
        var cache = new Dictionary<string, RecordLookupEntry?>();
        while (reader.Read())
        {
            list.Add(ReadDetail(reader, schema, fk =>
            {
                if (cache.TryGetValue(fk, out var t)) return t;
                var resolved = ResolveFormKey(fk);
                cache[fk] = resolved;
                return resolved;
            }));
        }

        return list;
    }

    // origin (#272 / ADR-0036, required since #275): the mod folder that provided this plugin's
    // physical file, or a reserved PluginOrigin value — paired with plugin, never encoded into it.
    public VmadData? GetVmad(string formKey, string plugin, string origin)
    {
        var scripts = ReadVmadScriptRows(formKey, plugin, origin);
        if (scripts.Count == 0) return null;

        var propRows = ReadVmadPropertyRows(formKey, plugin, origin);
        var propsByScript = propRows
            .GroupBy(r => r.ScriptName, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.OrderBy(r => r.PropertyIndex).ToList(), StringComparer.Ordinal);

        var itemRows = ReadVmadListItemRows(formKey, plugin, origin);
        var itemsByProp = itemRows
            .GroupBy(r => (r.ScriptName, r.PropertyIndex))
            .ToDictionary(g => g.Key, g => g.OrderBy(r => r.ListItemIndex).ToList());

        var scriptData = scripts
            .ConvertAll(s =>
            {
                var props = propsByScript.TryGetValue(s.Name, out var rows)
                    ? [.. rows.Select(r =>
                    {
                        var items = itemsByProp.GetValueOrDefault((r.ScriptName, r.PropertyIndex));
                        return new VmadNamedValue(r.PropertyName, MapVmadProperty(r, items));
                    })]
                    : new List<VmadNamedValue>();
                return new VmadScriptData(s.Name, s.Flags, props);
            });

        return new VmadData(scriptData);
    }

    // origin (#272 / ADR-0036, required since #275): the mod folder that provided this plugin's
    // physical file, or a reserved PluginOrigin value — paired with plugin, never encoded into it.
    public IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin, string origin)
    {
        var conditionRows = ReadConditionRows(formKey, plugin, origin);
        if (conditionRows.Count == 0) return [];

        var paramsByCondition = ReadConditionParamRows(formKey, plugin, origin)
            .GroupBy(p => (p.FieldPath, p.ConditionIndex))
            .ToDictionary(g => g.Key, g => g.OrderBy(p => p.ParamIndex)
                .Select(p => new ParsedConditionParam(
                    Enum.Parse<ConditionParamCategory>(p.Category), p.TypeName, p.Number, p.FormKey, p.Text,
                    DecodeParamValue(p.Category, p.TypeName, p.Number)))
                .ToList());

        return [.. conditionRows
            .GroupBy(c => c.FieldPath, StringComparer.Ordinal)
            .Select(g => new ConditionOwner(g.Key, [.. g
                .OrderBy(c => c.ConditionIndex)
                .Select(c => new ParsedCondition(
                    c.Function,
                    Enum.Parse<ConditionOperator>(c.Operator),
                    c.IsOr,
                    c.RunOnTarget,
                    c.RunOnReference,
                    c.UseGlobal,
                    c.ComparisonFloat,
                    c.ComparisonGlobal,
                    paramsByCondition.GetValueOrDefault((c.FieldPath, c.ConditionIndex)) ?? []))]))];
    }

    // #165: only a Number-category parameter is ever decodable (Form/Text are already
    // human-legible); a Form/Text row's stored number_value is null regardless of category, so this
    // also guards the null-Number case a Number row itself can never actually hit (Number.Value is
    // always non-null once category checks out — AppendParameter always writes one for that row).
    private string? DecodeParamValue(string category, string typeName, int? number) =>
        category == nameof(ConditionParamCategory.Number) && number is { } n
            ? _conditionCodec?.DecodeParamValue(typeName, n)
            : null;

    private List<ConditionRow> ReadConditionRows(string formKey, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT owner_field_path, condition_index, function, operator, is_or,
                   run_on_target, run_on_reference, use_global, comparison_float, comparison_global
            FROM conditions
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            ORDER BY owner_field_path, condition_index
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        using var reader = cmd.ExecuteReader();

        var rows = new List<ConditionRow>();
        while (reader.Read())
        {
            rows.Add(new ConditionRow(
                reader.GetString(0),
                reader.GetInt32(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetBoolean(4),
                reader.GetString(5),
                reader.IsDBNull(6) ? null : reader.GetString(6),
                reader.GetBoolean(7),
                reader.IsDBNull(8) ? null : reader.GetFloat(8),
                reader.IsDBNull(9) ? null : reader.GetString(9)));
        }

        return rows;
    }

    private List<ConditionParamRow> ReadConditionParamRows(string formKey, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT owner_field_path, condition_index, param_index, category, type_name,
                   number_value, formkey_value, text_value
            FROM condition_parameters
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            ORDER BY owner_field_path, condition_index, param_index
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        using var reader = cmd.ExecuteReader();

        var rows = new List<ConditionParamRow>();
        while (reader.Read())
        {
            rows.Add(new ConditionParamRow(
                reader.GetString(0),
                reader.GetInt32(1),
                reader.GetInt32(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.IsDBNull(5) ? null : reader.GetInt32(5),
                reader.IsDBNull(6) ? null : reader.GetString(6),
                reader.IsDBNull(7) ? null : reader.GetString(7)));
        }

        return rows;
    }

    private readonly record struct ConditionRow(
        string FieldPath, int ConditionIndex, string Function, string Operator, bool IsOr,
        string RunOnTarget, string? RunOnReference, bool UseGlobal, float? ComparisonFloat, string? ComparisonGlobal);

    private readonly record struct ConditionParamRow(
        string FieldPath, int ConditionIndex, int ParamIndex, string Category, string TypeName,
        int? Number, string? FormKey, string? Text);

    private readonly record struct VmadScriptRow(string Name, string Flags);

    private readonly record struct VmadPropertyRow(
        string ScriptName, string PropertyName, int PropertyIndex, string Type, string Flags,
        bool? Bool, int? Int, float? Float, string? String, string? FormKey, short? Alias, string? StructJson);

    private readonly record struct VmadListItemRow(
        string ScriptName, int PropertyIndex, int ListItemIndex, string Type,
        bool? Bool, int? Int, float? Float, string? String, string? FormKey, short? Alias);

    private List<VmadScriptRow> ReadVmadScriptRows(string formKey, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT script_name, flags FROM vmad_scripts
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            ORDER BY script_index
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        using var reader = cmd.ExecuteReader();

        var rows = new List<VmadScriptRow>();
        while (reader.Read())
            rows.Add(new VmadScriptRow(reader.GetString(0), reader.GetString(1)));
        return rows;
    }

    private List<VmadPropertyRow> ReadVmadPropertyRows(string formKey, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT script_name, property_name, property_index, type, flags,
                   bool_value, int_value, float_value, string_value, form_key_value, alias_value, struct_json
            FROM vmad_properties
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            ORDER BY property_index
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        using var reader = cmd.ExecuteReader();

        var rows = new List<VmadPropertyRow>();
        while (reader.Read())
        {
            rows.Add(new VmadPropertyRow(
                reader.GetString(0), reader.GetString(1), reader.GetInt32(2), reader.GetString(3), reader.GetString(4),
                reader.IsDBNull(5) ? null : reader.GetBoolean(5),
                reader.IsDBNull(6) ? null : reader.GetInt32(6),
                reader.IsDBNull(7) ? null : reader.GetFloat(7),
                reader.IsDBNull(8) ? null : reader.GetString(8),
                reader.IsDBNull(9) ? null : reader.GetString(9),
                reader.IsDBNull(10) ? null : reader.GetInt16(10),
                reader.IsDBNull(11) ? null : reader.GetString(11)));
        }

        return rows;
    }

    private List<VmadListItemRow> ReadVmadListItemRows(string formKey, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT script_name, property_index, list_item_index, type,
                   bool_value, int_value, float_value, string_value, form_key_value, alias_value
            FROM vmad_property_list_items
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            ORDER BY property_index, list_item_index
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        using var reader = cmd.ExecuteReader();

        var rows = new List<VmadListItemRow>();
        while (reader.Read())
        {
            rows.Add(new VmadListItemRow(
                reader.GetString(0), reader.GetInt32(1), reader.GetInt32(2), reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetBoolean(4),
                reader.IsDBNull(5) ? null : reader.GetInt32(5),
                reader.IsDBNull(6) ? null : reader.GetFloat(6),
                reader.IsDBNull(7) ? null : reader.GetString(7),
                reader.IsDBNull(8) ? null : reader.GetString(8),
                reader.IsDBNull(9) ? null : reader.GetInt16(9)));
        }

        return rows;
    }

    // Types with an element type are the ones whose elements come from vmad_property_list_items rows.
    private static VmadPropertyValue MapVmadProperty(VmadPropertyRow r, List<VmadListItemRow>? items) =>
        VmadCodec.ElementType(r.Type) is not null
            ? new VmadPropertyValue(r.Type, r.Flags, null, ListItems: MapVmadItems(items))
            : MapNonArrayVmadProperty(r);

    private static VmadPropertyValue MapNonArrayVmadProperty(VmadPropertyRow r) => r.Type switch
    {
        "Bool" => new VmadPropertyValue(r.Type, r.Flags, r.Bool),
        "Int" => new VmadPropertyValue(r.Type, r.Flags, r.Int),
        "Float" => new VmadPropertyValue(r.Type, r.Flags, r.Float),
        "String" => new VmadPropertyValue(r.Type, r.Flags, r.String),
        "Object" => new VmadPropertyValue(r.Type, r.Flags, r.FormKey, r.Alias),
        "Struct" => new VmadPropertyValue(r.Type, r.Flags, null, Members: MapStructMembers(r.StructJson)),
        "ArrayOfStruct" => new VmadPropertyValue(r.Type, r.Flags, null, StructList: MapStructList(r.StructJson)),
        _ => new VmadPropertyValue(r.Type, r.Flags, null),
    };

    private static List<VmadNamedValue>? MapStructMembers(string? structJson) =>
        structJson is null
            ? null
            : [.. VmadCodec.StructMembers(structJson).Select(n => new VmadNamedValue(n.Name, MapNode(n)))];

    private static List<IReadOnlyList<VmadNamedValue>>? MapStructList(string? structJson)
    {
        return structJson is null
            ? null
            : ([.. VmadJson.DeserializeStructList(structJson).Select(inst => (IReadOnlyList<VmadNamedValue>)MapNodes(inst.Members))]);
    }

    private static List<VmadNamedValue> MapNodes(VmadPropertyNode[] nodes) =>
        [.. nodes.Select(n => new VmadNamedValue(n.Name, MapNode(n)))];

    private static VmadPropertyValue MapNode(VmadPropertyNode n) => n.Type switch
    {
        "Bool" => new VmadPropertyValue(n.Type, n.Flags, n.BoolValue),
        "Int" => new VmadPropertyValue(n.Type, n.Flags, n.IntValue),
        "Float" => new VmadPropertyValue(n.Type, n.Flags, n.FloatValue),
        "String" => new VmadPropertyValue(n.Type, n.Flags, n.StringValue),
        "Object" => new VmadPropertyValue(n.Type, n.Flags, n.FormKeyValue, n.AliasValue),
        "Struct" => new VmadPropertyValue(n.Type, n.Flags, null, Members: MapNodes(n.Members ?? [])),
        _ => new VmadPropertyValue(n.Type, n.Flags, null),
    };

    // Array elements carry no per-element flags (flags live at the property level only), hence "".
    private static List<VmadPropertyValue> MapVmadItems(List<VmadListItemRow>? items) =>
        items is null
            ? []
            : [.. items.Select(i => VmadCodec.ElementType(i.Type) switch
            {
                "Bool" => new VmadPropertyValue("Bool", "", i.Bool),
                "Int" => new VmadPropertyValue("Int", "", i.Int),
                "Float" => new VmadPropertyValue("Float", "", i.Float),
                "String" => new VmadPropertyValue("String", "", i.String),
                "Object" => new VmadPropertyValue("Object", "", i.FormKey, i.Alias),
                _ => new VmadPropertyValue(i.Type, "", null),
            })];

    public int CountRecordsForPlugin(string tableName, string plugin)
    {
        var (where, paramValues) = BuildWhere(plugin, null, _filterActive);
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM \"{tableName}\"{where}";
        AddParams(cmd, paramValues);
        return (int)(long)cmd.ExecuteScalar()!;
    }

    public string? FindRecordType(string formKey)
    {
        var schemas = RequireSchemas();
        foreach (var tableName in schemas.Keys)
        {
            using var cmd = Connection.CreateCommand();
            cmd.CommandText = $"SELECT 1 FROM \"{tableName}\" WHERE form_key = $1 LIMIT 1";
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            if (cmd.ExecuteScalar() != null) return tableName;
        }
        return null;
    }

    public RecordLookupEntry? ResolveFormKey(string formKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = "SELECT record_type, editor_id FROM form_lookup WHERE form_key = $1 AND is_winner LIMIT 1";
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        using var reader = cmd.ExecuteReader();

        // Local function so the merged conditional expression below doesn't nest a ternary per
        // coordinate (SonarS3358), matching GetPlacement's NullableFloat pattern.
        string? NullableEditorId() => reader.IsDBNull(1) ? null : reader.GetString(1);

        return !reader.Read()
            ? null
            : new RecordLookupEntry(reader.GetString(0), NullableEditorId());
    }

    public IReadOnlyList<string> GetNativeFormKeys(string plugin)
    {
        var tables = RequireSchemas().Keys.Where(t => t != HeaderIndexer.TableName).ToList();
        if (tables.Count == 0) return [];

        var union = string.Join("\nUNION ALL\n",
            tables.Select(t => $"SELECT form_key FROM \"{t}\" WHERE plugin = $1"));

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT DISTINCT form_key FROM ({union})";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        using var reader = cmd.ExecuteReader();

        var result = new List<string>();
        while (reader.Read())
        {
            var fk = reader.GetString(0);
            var colon = fk.IndexOf(':');
            // "Native" = the record's own FormKey ModKey is this plugin (not an override of a master).
            if (colon > 0 && fk.AsSpan(colon + 1).Equals(plugin, StringComparison.OrdinalIgnoreCase))
                result.Add(fk);
        }
        return result;
    }

    public PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> tableNames, string? plugin, string? search, int limit, int offset)
    {
        if (tableNames.Count == 0)
            return new PagedResult<RecordSummary>([], 0);

        var (where, paramValues) = BuildWhere(plugin, search, _filterActive);
        const string cols = "form_key, plugin, load_order_idx, is_winner, editor_id";
        var union = string.Join("\nUNION ALL\n",
            tableNames.Select(t => $"SELECT {cols} FROM \"{t}\"{where}"));

        using var countCmd = Connection.CreateCommand();
        countCmd.CommandText = $"SELECT COUNT(*) FROM ({union})";
        AddParams(countCmd, paramValues);
        var total = (long)countCmd.ExecuteScalar()!;

        using var dataCmd = Connection.CreateCommand();
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

    private static RecordDetail ReadDetail(DuckDBDataReader reader, RecordTableSchema schema, Func<string, RecordLookupEntry?> resolveFormKey)
    {
        var formKey = reader.GetString(0);
        var plugin = reader.GetString(1);
        var origin = reader.GetString(2);
        var loadOrderIndex = reader.GetInt32(3);
        var isWinner = reader.GetBoolean(4);
        var editorId = reader.IsDBNull(5) ? null : reader.GetString(5);

        var fields = new List<FieldValue>();
        for (int i = 0; i < schema.RecordColumns.Count; i++)
        {
            var col = schema.RecordColumns[i];
            var isDbNull = reader.IsDBNull(6 + i);
            object? value = (isDbNull, col.IsArray || col.SubFields != null) switch
            {
                (true, _) => null,
                (false, true) => JsonSerializer.Deserialize<JsonElement>(reader.GetString(6 + i)),
                _ => reader.GetValue(6 + i),
            };
            // Bitmask flag values can exceed 2^53 (e.g. FO4 Race.Flag bits 53/54). Surface them as
            // decimal strings so they survive JSON round-tripping without IEEE 754 precision loss.
            if (value != null && col.IsBitmask)
                value = Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
            var meta = col.ToFieldMetadata();
            fields.Add(new FieldValue(meta, value, CheckErrorBuilder.Build(meta, value, resolveFormKey)));
        }

        return new RecordDetail(formKey, plugin, loadOrderIndex, isWinner, editorId, fields, RecordType: schema.TableName, Origin: origin);
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
            // Issue #210: a FormKey-shaped query (e.g. seeded by the picker from the record's own
            // reference, or pasted per #201) resolves directly against the exact stored form_key
            // rather than an EditorID substring match — form_key values are always stored via
            // Mutagen's own FormKey.ToString(), so round-tripping the query through
            // FormKey.TryFactory/.ToString() canonicalizes case/format to match. A query that merely
            // looks FormKey-ish but doesn't fully parse falls through to the EditorID match below,
            // same as always.
            if (Mutagen.Bethesda.Plugins.FormKey.TryFactory(search, out var formKey))
            {
                // Case-insensitive: FormKey.TryFactory canonicalizes the hex id but does not
                // re-case the ModKey (plugin) portion against known data, so a user-typed
                // lowercase plugin name would otherwise miss an exact case-sensitive match.
                conditions.Add($"LOWER(form_key) = LOWER(${values.Count + 1})");
                values.Add(formKey.ToString());
            }
            else
            {
                conditions.Add($"editor_id ILIKE ${values.Count + 1}");
                values.Add($"%{search}%");
            }
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

    // #271/#272 / ADR-0036: scoped to (plugin, origin) together — reindexing one origin's plugin
    // must never delete another origin's rows for the same filename. Every reindexed table now
    // goes through this (the filename-only `DeleteExisting` predecessor was deleted once header,
    // #272's last holdout, moved to this method too — see IndexHeader below).
    private void DeleteExistingForOrigin(string tableName, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"DELETE FROM \"{tableName}\" WHERE plugin = $1 AND origin = $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        cmd.ExecuteNonQuery();
    }

    private void DeleteFormReferencesForPlugin(string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = "DELETE FROM form_references WHERE source_plugin = $1 AND source_origin = $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        cmd.ExecuteNonQuery();
    }

    private void IndexVmad(IModGetter pluginMod, string plugin, string origin, List<FormRef> refs)
    {
        using var scriptAppender = Connection.CreateAppender("vmad_scripts");
        using var propAppender = Connection.CreateAppender("vmad_properties");
        using var itemAppender = Connection.CreateAppender("vmad_property_list_items");
        var indexer = new VmadIndexer(scriptAppender, propAppender, itemAppender, refs, _logger);

        var vmadCount = 0;
        foreach (var record in pluginMod.EnumerateMajorRecords<IHaveVirtualMachineAdapterGetter>(
                     throwIfUnknown: false))
        {
            if (record.VirtualMachineAdapter is not { } vmad) continue;
            var recordType = ResolveRecordType(record);
            try
            {
                indexer.IndexRecord(record.FormKey.ToString(), plugin, origin, recordType, vmad);
                vmadCount++;
                _logger.LogTrace("Indexed VMAD for {FormKey} ({RecordType}) in {Plugin}",
                    record.FormKey, recordType, plugin);
            }
            catch (NotImplementedException ex)
            {
                _logger.LogWarning(ex,
                    "Skipping VMAD for {FormKey} — property type not implemented in Mutagen",
                    record.FormKey);
            }
        }
        _logger.LogDebug("Indexed VMAD for {Count} records in {Plugin}", vmadCount, plugin);
    }

    // Phase 16: populate the worldspace-tree side tables from the GRUP hierarchy that
    // EnumerateMajorRecords flattens away.
    private void IndexPlacement(IModGetter pluginMod, string plugin, string origin)
    {
        DeleteExistingForOrigin("placement", plugin, origin);
        DeleteExistingForOrigin("cell_location", plugin, origin);

        using var cellAppender = Connection.CreateAppender("cell_location");
        using var placeAppender = Connection.CreateAppender("placement");

        _placementWalker.Walk(pluginMod,
            cell =>
            {
                var row = cellAppender.CreateRow();
                row.AppendValue(cell.CellFormKey);
                row.AppendValue(plugin);
                row.AppendValue(origin);
                DuckDbAppend.Nullable(row, cell.ParentWorldspace);
                DuckDbAppend.Nullable(row, cell.BlockX);
                DuckDbAppend.Nullable(row, cell.BlockY);
                DuckDbAppend.Nullable(row, cell.SubX);
                DuckDbAppend.Nullable(row, cell.SubY);
                DuckDbAppend.Nullable(row, cell.GridX);
                DuckDbAppend.Nullable(row, cell.GridY);
                DuckDbAppend.Nullable(row, cell.IsInterior);
                row.EndRow();
            },
            placed =>
            {
                var row = placeAppender.CreateRow();
                row.AppendValue(placed.FormKey);
                row.AppendValue(plugin);
                row.AppendValue(origin);
                row.AppendValue(placed.ParentCell);
                row.AppendValue(placed.PlacementGroup);
                DuckDbAppend.Nullable(row, placed.PosX);
                DuckDbAppend.Nullable(row, placed.PosY);
                DuckDbAppend.Nullable(row, placed.PosZ);
                row.EndRow();
            });
    }

    // Issue #1 slice A1: header rows never flow through IndexRecordTable (see the Index() skip
    // above), so they need their own delete-then-append step, matching every other side table.
    // #271/#272 / ADR-0036: the header table's DDL comes from the same generic CreateRecordTable as
    // every reflected schema, so it carries the `origin` column too — HeaderIndexer.Index has
    // appended it since #271; the delete step below was #272's last remaining filename-only gap
    // (VMAD/conditions/form_lookup were migrated to DeleteExistingForOrigin earlier in this same
    // ticket) and is now scoped to (plugin, origin) here too.
    private void IndexHeader(
        IModGetter pluginMod, string plugin, string origin, int loadOrderIndex,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (!schemas.TryGetValue("header", out var headerSchema)) return;

        DeleteExistingForOrigin("header", plugin, origin);
        using var appender = Connection.CreateAppender("header");
        HeaderIndexer.Index(pluginMod, plugin, origin, loadOrderIndex, headerSchema, appender);
    }

    private void DeleteVmadForPlugin(string plugin, string origin)
    {
        foreach (var table in (string[])["vmad_scripts", "vmad_properties", "vmad_property_list_items"])
            DeleteExistingForOrigin(table, plugin, origin);
    }

    private void DeleteConditionsForPlugin(string plugin, string origin)
    {
        foreach (var table in (string[])["conditions", "condition_parameters"])
            DeleteExistingForOrigin(table, plugin, origin);
    }

    // Walks every major record through the per-game condition codec (ADR-0032). No aspect interface
    // groups condition-bearing records, so enumeration is unfiltered; the codec's reflect-for-
    // `Conditions` check is cheap and yields nothing for records without conditions.
    //
    // refs: the same shared list IndexVmad appends to, both flushed to form_references in one pass
    // after Index()'s per-type loop (#166 — ConditionIndexer now feeds it too, closing the gap where
    // a record referenced only by a condition never appeared in form_references).
    private void IndexConditions(IModGetter pluginMod, string plugin, string origin, List<FormRef> refs)
    {
        var codec = ConditionCodecRegistry.For(pluginMod.GameRelease.ToCategory());
        if (codec == null)
        {
            _logger.LogWarning("No condition codec for {Game}; skipping condition index for {Plugin}",
                pluginMod.GameRelease, plugin);
            return;
        }

        using var conditionAppender = Connection.CreateAppender("conditions");
        using var paramAppender = Connection.CreateAppender("condition_parameters");
        var indexer = new ConditionIndexer(conditionAppender, paramAppender, refs);

        var count = 0;
        foreach (var record in pluginMod.EnumerateMajorRecords())
        {
            var owners = codec.Extract(record);
            if (!owners.Any()) continue;
            var recordType = ResolveRecordType(record);
            indexer.IndexRecord(record.FormKey.ToString(), plugin, origin, recordType, owners);
            count++;
            _logger.LogTrace("Indexed conditions for {FormKey} ({RecordType}) in {Plugin}",
                record.FormKey, recordType, plugin);
        }

        _logger.LogDebug("Indexed conditions for {Count} records in {Plugin}", count, plugin);
    }

    private string ResolveRecordType(IMajorRecordGetter record)
    {
        var schemas = RequireSchemas();
        foreach (var (tableName, schema) in schemas)
        {
            if (schema.RecordType.IsInstanceOfType(record))
                return tableName;
        }

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
        using var cmd = Connection.CreateCommand();
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
        const string sql = """
            SELECT fr.source_form_key, fr.source_plugin, fr.field_path, fr.record_type, fr.editor_id
            FROM form_references fr
            WHERE fr.target_form_key = $1
              AND NOT EXISTS (
                SELECT 1 FROM pending_changes pc
                WHERE pc.form_key = fr.source_form_key
                  AND pc.plugin   = fr.source_plugin
                  AND pc.origin   = fr.source_origin
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

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        AddParams(cmd, [targetFormKey]);

        var results = new List<ReferenceResult>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            results.Add(new ReferenceResult(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4)));
        }

        return results;
    }

    // ── Phase 16: worldspace tree reads ────────────────────────────────────────

    public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(string plugin, string worldspaceFormKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT cl.cell_form_key, c.editor_id, cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y
            FROM cell_location cl
            LEFT JOIN cell c ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
            WHERE cl.parent_worldspace = $1 AND cl.plugin = $2
            ORDER BY cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y
            """;
        AddParams(cmd, [worldspaceFormKey, plugin]);
        using var reader = cmd.ExecuteReader();

        var rows = new List<CellLocationSummary>();
        while (reader.Read())
        {
            rows.Add(new CellLocationSummary(
                reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetInt32(2),
                reader.IsDBNull(3) ? null : reader.GetInt32(3),
                reader.IsDBNull(4) ? null : reader.GetInt32(4),
                reader.IsDBNull(5) ? null : reader.GetInt32(5),
                reader.IsDBNull(6) ? null : reader.GetInt32(6),
                reader.IsDBNull(7) ? null : reader.GetInt32(7)));
        }

        return rows;
    }

    public PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset)
    {
        using var countCmd = Connection.CreateCommand();
        countCmd.CommandText = "SELECT COUNT(*) FROM cell_location WHERE is_interior AND plugin = $1";
        countCmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        var total = (long)countCmd.ExecuteScalar()!;

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT cl.cell_form_key, c.editor_id, cl.grid_x, cl.grid_y
            FROM cell_location cl
            LEFT JOIN cell c ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
            WHERE cl.is_interior AND cl.plugin = $1
            ORDER BY c.editor_id
            LIMIT {limit} OFFSET {offset}
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        using var reader = cmd.ExecuteReader();

        var items = new List<CellSummary>();
        while (reader.Read())
        {
            items.Add(new CellSummary(
                reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetInt32(2),
                reader.IsDBNull(3) ? null : reader.GetInt32(3)));
        }

        return new PagedResult<CellSummary>(items, (int)total);
    }

    public CellReferences GetCellReferences(string plugin, string cellFormKey)
    {
        var schemas = RequireSchemas();
        var placedTables = PlacedTableNames.Where(schemas.ContainsKey).ToList();
        if (placedTables.Count == 0)
            return new CellReferences([], []);

        var union = string.Join("\nUNION ALL\n",
            placedTables.Select(t => $"SELECT '{t}' AS rt, form_key, plugin, origin, editor_id, \"base\" FROM \"{t}\""));

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT p.placement_group, r.rt, p.form_key, r.editor_id, r.base
            FROM placement p
            JOIN ({union}) r ON r.form_key = p.form_key AND r.plugin = p.plugin AND r.origin = p.origin
            WHERE p.parent_cell = $1 AND p.plugin = $2
            ORDER BY r.editor_id
            """;
        AddParams(cmd, [cellFormKey, plugin]);
        using var reader = cmd.ExecuteReader();

        var persistent = new List<PlacedSummary>();
        var temporary = new List<PlacedSummary>();
        while (reader.Read())
        {
            var group = reader.GetString(0);
            var summary = new PlacedSummary(
                reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetString(1));
            (group == "persistent" ? persistent : temporary).Add(summary);
        }
        return new CellReferences(persistent, temporary);
    }

    // origin (#272 / ADR-0036, required since #275): same reasoning as GetVmad's/Index's.
    public PlacementRow? GetPlacement(string formKey, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT parent_cell, placement_group, pos_x, pos_y, pos_z
            FROM placement
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """;
        AddParams(cmd, [formKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        // Local function so the merged conditional expression below doesn't nest a ternary per
        // coordinate (SonarS3358) while still collapsing the guard clause per IDE0046.
        float? NullableFloat(int i) => reader.IsDBNull(i) ? null : reader.GetFloat(i);

        return !reader.Read()
            ? null
            : new PlacementRow(
                formKey,
                reader.GetString(0),
                reader.GetString(1),
                NullableFloat(2),
                NullableFloat(3),
                NullableFloat(4));
    }

    public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames)
    {
        var tables = tableNames.ToList();
        if (tables.Count == 0 || !_filterActive)
            return new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var union = string.Join("\nUNION ALL\n",
            tables.Select(t => $"SELECT plugin FROM \"{t}\" WHERE form_key IN (SELECT form_key FROM _filter)"));

        using var cmd = Connection.CreateCommand();
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

        using var probeCmd = Connection.CreateCommand();
        probeCmd.CommandText = $"SELECT * FROM ({sql}) __probe LIMIT 0";
        using var probeReader = probeCmd.ExecuteReader();
        bool hasFormKey = Enumerable.Range(0, probeReader.FieldCount)
            .Any(i => string.Equals(probeReader.GetName(i), "form_key", StringComparison.OrdinalIgnoreCase));

        if (!hasFormKey)
            throw new ArgumentException("Filter SQL must return a form_key column");

        Execute($"CREATE OR REPLACE TABLE _filter AS ({sql})");
        _filterActive = true;
    }

    public void Dispose() => Connection.Dispose();
}
