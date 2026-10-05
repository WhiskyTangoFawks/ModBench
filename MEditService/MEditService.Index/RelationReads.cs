using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>Every read the index answers, over the Store's relations (ADR-0010).</summary>
internal sealed class RelationReads(
    Store store, Func<IReadOnlyDictionary<PluginAddress, PluginContent>> openedPlugins) : IRecordReads
{
    private static readonly string[] CellChildTypeNames = ["refr", "achr", "land", "navm"];

    public IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins => openedPlugins();

    // A SELECT COUNT(*) always answers exactly one row with a non-null count.
    private static long ExecuteCount(DuckDBCommand cmd) =>
        (long)(cmd.ExecuteScalar() ?? throw new InvalidOperationException("Expected SELECT COUNT(*) to return a value."));

    public RecordDocument? GetDocument(string formKey)
    {
        using var connection = store.OpenReadConnection();
        var tableName = FindRecordType(connection, formKey);
        return tableName == null ? null : ReadDocument(connection, tableName, formKey, plugin: null, origin: null, winnerOnly: true);
    }

    public RecordDocument? GetDocument(string formKey, PluginAddress plugin)
    {
        using var connection = store.OpenReadConnection();
        var tableName = FindRecordType(connection, formKey);
        return tableName == null ? null : ReadDocument(connection, tableName, formKey, plugin.Name, plugin.Origin, winnerOnly: false);
    }

    // One query rather than two point queries per record. Rows are materialized before
    // reconstitution: resolving a FormKey opens its own command on this connection, which would
    // interleave two readers.
    public IReadOnlyList<RecordDocument> GetDocuments(PluginAddress plugin)
    {
        using var connection = store.OpenReadConnection();
        var schemas = store.Schemas;
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, record_type, parse_diagnosis
            FROM records
            WHERE plugin = $1 AND origin = $2
            """;
        DuckDbSql.AddParams(cmd, [plugin.Name, plugin.Origin]);
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string FormKey, string Plugin, string Origin, int LoadOrderIndex,
            bool IsWinner, string? EditorId, string Body, string RecordType, string? ParseDiagnosis)>();
        while (reader.Read())
        {
            rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2),
                LoadOrderSortKey(reader, 3), reader.GetBoolean(4),
                reader.IsDBNull(5) ? null : reader.GetString(5),
                reader.GetString(6), reader.GetString(7), reader.IsDBNull(8) ? null : reader.GetString(8)));
        }
        reader.Close();

        var resolve = LinkResolution.ForLinksOf(connection, plugin);

        var documents = new List<RecordDocument>(rows.Count);
        foreach (var row in rows)
        {
            // Same defensive skip as RederiveIndexRowsForRecord: a record_type no schema claims
            // has no reconstitution path.
            if (!schemas.TryGetValue(row.RecordType, out var schema)) continue;
            documents.Add(DocumentFromBody(
                row.FormKey, row.Plugin, row.Origin, row.LoadOrderIndex, row.IsWinner,
                row.EditorId, row.Body, schema, resolve, row.ParseDiagnosis));
        }
        return documents;
    }

    public RecordOverrides? GetOverrideStack(string formKey)
    {
        using var connection = store.OpenReadConnection();
        var tableName = FindRecordType(connection, formKey);
        if (tableName == null) return null;
        var schema = store.Schemas[tableName];
        var resolve = LinkResolution.ForLinksOf(connection, formKey);
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, parse_diagnosis, working_tree_state
            FROM records
            WHERE form_key = $1 AND record_type = $2
            ORDER BY load_order_idx
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = NormalizeRecordType(tableName) });
        using var reader = cmd.ExecuteReader();

        var entries = new List<OverrideStackEntry>();
        while (reader.Read())
        {
            var doc = ReadDocumentFromBody(reader, schema, resolve);
            var isDirty = WorkingTreeStates.FromStored(reader.GetString(8)) != WorkingTreeState.None;
            entries.Add(new OverrideStackEntry(doc.Plugin, doc.LoadOrderIndex, doc.IsWinner, doc, isDirty));
        }

        return entries.Count == 0 ? null : new RecordOverrides(formKey, tableName, entries);
    }

    public PagedResult<RecordSummary> Search(RecordQuery query)
    {
        using var connection = store.OpenReadConnection();
        var (where, paramValues) = BuildWhere(
            query.Plugin?.Name, query.Search, query.Unfiltered ? null : store.Filter.Listing, query.Origin, query.RecordTypes,
            query.GroupOnly ? NavigatorSql.NotHeld("r") : null, query.SearchFormKey);
        var dataParams = new List<string>(paramValues);
        var holdings = HoldingsOf(query.Plugin?.Name, query.Origin, dataParams);
        var cols = $"""
            form_key, plugin, load_order_idx, is_winner, editor_id, origin, r.working_tree_state,
            EXISTS (
                SELECT 1 FROM container_child cc
                WHERE cc.parent_form_key = r.form_key AND cc.plugin = r.plugin AND cc.origin = r.origin
                  {(query.Unfiltered ? "" : store.Filter.AlsoKeeps("cc", "child_form_key"))}
            ) AS has_container_children,
            r.parse_diagnosis,
            r.parse_diagnosis IS NOT NULL OR EXISTS (
                SELECT 1 FROM above_failure a
                WHERE a.form_key = r.form_key AND a.plugin = r.plugin AND a.origin = r.origin
            ) AS has_parse_failure,
            {FullNameOf("r")} AS full_name
            """;

        using var countCmd = connection.CreateCommand();
        countCmd.CommandText = $"SELECT COUNT(*) FROM records r{where}";
        DuckDbSql.AddParams(countCmd, paramValues);
        var total = ExecuteCount(countCmd);

        // xEdit's navigator lists a group in FormID order, and its record picker lists by EditorID.
        // (plugin, origin) makes either order total, so LIMIT/OFFSET pages stably.
        var order = query.GroupOnly ? NavigatorSql.FormIdOrder("form_key") : "editor_id, form_key";
        using var dataCmd = connection.CreateCommand();
        dataCmd.CommandText = $"""
            WITH RECURSIVE {NavigatorSql.AboveAFailure("records", holdings)}
            SELECT {cols} FROM records r{where}
            ORDER BY {order}, plugin, origin
            LIMIT {query.Limit} OFFSET {query.Offset}
            """;
        DuckDbSql.AddParams(dataCmd, dataParams);

        var items = new List<RecordSummary>();
        using var reader = dataCmd.ExecuteReader();
        while (reader.Read())
            items.Add(ReadSummary(reader));

        return new PagedResult<RecordSummary>(items, (int)total);
    }

    // A listing of one plugin walks that plugin's holdings alone, bound after the listing's own
    // parameters.
    private static string HoldingsOf(string? plugin, string? origin, List<string> paramValues)
    {
        var conditions = new List<string>();
        if (plugin != null)
        {
            paramValues.Add(plugin);
            conditions.Add($"h.plugin = ${paramValues.Count}");
        }
        if (origin != null)
        {
            paramValues.Add(origin);
            conditions.Add($"h.origin = ${paramValues.Count}");
        }
        return conditions.Count == 0 ? "" : "WHERE " + string.Join(" AND ", conditions);
    }

    // The filter narrows counts the same way it narrows listings (invariant: SetFilter affects
    // Search/counts/plugin-highlight, never a point read), routed through the same BuildWhere
    // every other filterable query here uses.
    public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginAddress plugin)
    {
        using var connection = store.OpenReadConnection();
        var (where, paramValues) = BuildWhere(
            plugin.Name, null, store.Filter.Listing, plugin.Origin, recordTypes: null, NavigatorSql.NotHeld("r"));
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT record_type, COUNT(*), BOOL_OR(parse_diagnosis IS NOT NULL)
            FROM records r{where}
            GROUP BY record_type
            """;
        DuckDbSql.AddParams(cmd, paramValues);
        var counts = new List<RecordTypeCount>();
        using (var reader = cmd.ExecuteReader())
        {
            while (reader.Read())
                counts.Add(new RecordTypeCount(reader.GetString(0), (int)reader.GetInt64(1), reader.GetBoolean(2)));
        }

        // Merged in C# rather than joined: a type whose enumeration failed can have no rows
        // at all, so it is absent from the GROUP BY above and would vanish from the tree.
        var failedTypes = FailedRecordTypes(connection, plugin);
        var holdingAFailure = TypesHoldingAFailure(connection, plugin);
        for (var i = 0; i < counts.Count; i++)
        {
            if (failedTypes.Contains(counts[i].Type) || holdingAFailure.Contains(counts[i].Type))
                counts[i] = counts[i] with { HasParseFailure = true };
        }
        counts.AddRange(failedTypes
            .Where(t => !counts.Exists(c => string.Equals(c.Type, t, StringComparison.OrdinalIgnoreCase)))
            .Select(t => new RecordTypeCount(t, 0, HasParseFailure: true)));
        return counts;
    }

    // The types of the listed records with an unreadable record anywhere beneath them, walked up
    // the holdings from each unreadable record.
    private static HashSet<string> TypesHoldingAFailure(DuckDBConnection connection, PluginAddress plugin)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            WITH RECURSIVE {NavigatorSql.AboveAFailure("records", "WHERE h.plugin = $1 AND h.origin = $2")}
            SELECT DISTINCT r.record_type FROM records r
            JOIN above_failure a ON a.form_key = r.form_key AND a.plugin = r.plugin AND a.origin = r.origin
            WHERE r.plugin = $1 AND r.origin = $2 AND {NavigatorSql.NotHeld("r")}
            """;
        DuckDbSql.AddParams(cmd, [plugin.Name, plugin.Origin]);
        using var reader = cmd.ExecuteReader();

        var types = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (reader.Read()) types.Add(reader.GetString(0));
        return types;
    }

    // Unfiltered: a record filter narrows what is listed, never whether a type could be read.
    private static HashSet<string> FailedRecordTypes(DuckDBConnection connection, PluginAddress plugin)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText =
            "SELECT DISTINCT record_type FROM record_type_failure WHERE plugin = $1 AND origin = $2";
        DuckDbSql.AddParams(cmd, [plugin.Name, plugin.Origin]);
        using var reader = cmd.ExecuteReader();

        var types = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (reader.Read()) types.Add(reader.GetString(0));
        return types;
    }

    public RecordLookupEntry? Resolve(string formKey)
    {
        using var connection = store.OpenReadConnection();
        return LinkResolution.Resolve(connection, formKey);
    }

    public Func<string, RecordLookupEntry?> LinkResolver(string formKey)
    {
        using var connection = store.OpenReadConnection();
        return LinkResolution.ForLinksOf(connection, formKey, Resolve);
    }

    public IReadOnlyList<ReferenceRow> GetReferencedBy(string targetFormKey)
    {
        using var connection = store.OpenReadConnection();
        return GetReferences(connection, targetFormKey);
    }

    public IReadOnlySet<PluginAddress> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames)
    {
        var types = tableNames.ToList();
        if (types.Count == 0 || !store.Filter.Active)
            return new HashSet<PluginAddress>(PluginAddress.Comparer);

        using var connection = store.OpenReadConnection();

        var (where, paramValues) = BuildWhere(
            null, null, RecordFilter.Matching, origin: null, recordTypes: types);

        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT DISTINCT plugin, origin FROM records{where}";
        DuckDbSql.AddParams(cmd, paramValues);
        using var reader = cmd.ExecuteReader();

        var result = new HashSet<PluginAddress>(PluginAddress.Comparer);
        while (reader.Read())
            result.Add(new PluginAddress(reader.GetString(0), reader.GetString(1)));
        return result;
    }

    public IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses()
    {
        using var connection = store.OpenReadConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT plugin, origin, anchor, defect_class, tail, message
            FROM {TableDdlBuilder.PluginDiagnosisTable}
            ORDER BY plugin, origin, ordinal
            """;
        using var reader = cmd.ExecuteReader();

        var rows = new List<PluginDiagnosisRow>();
        while (reader.Read())
        {
            rows.Add(new PluginDiagnosisRow(
                new PluginAddress(reader.GetString(0), reader.GetString(1)),
                new PluginDiagnosis(
                    reader.IsDBNull(2) ? null : reader.GetString(2),
                    reader.GetString(3),
                    reader.IsDBNull(4) ? null : reader.GetString(4),
                    reader.GetString(5))));
        }
        return rows;
    }

    public IReadOnlySet<PluginAddress> GetTrackedPlugins()
    {
        using var connection = store.OpenReadConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT plugin, origin FROM {TableDdlBuilder.PluginDerivationTable} WHERE derived_from = $1";
        DuckDbSql.AddParams(cmd, [DerivedFrom.SourceTree.ToString()]);
        using var reader = cmd.ExecuteReader();

        var tracked = new HashSet<PluginAddress>(PluginAddress.Comparer);
        while (reader.Read())
            tracked.Add(new PluginAddress(reader.GetString(0), reader.GetString(1)));
        return tracked;
    }

    /// <summary>Both halves of "could not be read": a record whose own document failed, and a
    /// record type whose enumeration did. Keyed by <c>ColumnKey.Of</c> rather than a bare
    /// filename, which two loaded plugins can share.</summary>
    public IReadOnlySet<string> GetPluginsWithParseFailures()
    {
        using var connection = store.OpenReadConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT DISTINCT r.plugin, r.origin FROM {TableDdlBuilder.MirrorSchema}.records r
            {TableDdlBuilder.RegisteredJoin("r", "plugin", "origin")}
            WHERE r.parse_diagnosis IS NOT NULL
            UNION
            SELECT DISTINCT plugin, origin FROM record_type_failure
            """;
        using var reader = cmd.ExecuteReader();

        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (reader.Read())
            result.Add(ColumnKey.Of(reader.GetString(0), reader.GetString(1)));
        return result;
    }

    public IReadOnlyList<string> GetNativeFormKeys(PluginAddress plugin)
    {
        using var connection = store.OpenReadConnection();
        // The header is excluded explicitly: its synthetic 000000:<plugin> FormKey names no record,
        // and the caller that computes the next free local FormID would be handed a FormKey no
        // record occupies.
        using var cmd = connection.CreateCommand();
        cmd.CommandText =
            $"SELECT DISTINCT form_key FROM records WHERE plugin = $1 AND origin = $2 AND record_type <> '{PluginHeader.RecordType}'";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Name });
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Origin });
        using var reader = cmd.ExecuteReader();

        var result = new List<string>();
        while (reader.Read())
        {
            var fk = reader.GetString(0);
            var colon = fk.IndexOf(':');
            if (colon > 0 && fk.AsSpan(colon + 1).Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
                result.Add(fk);
        }
        return result;
    }

    public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginAddress plugin, string worldspaceFormKey) =>
        CellLocations(plugin, "cl.parent_worldspace = $3", "cl.block_x, cl.block_y, cl.sub_x, cl.sub_y", [worldspaceFormKey]);

    public IReadOnlyList<CellLocationSummary> GetInteriorCells(PluginAddress plugin) =>
        CellLocations(plugin, "cl.is_interior", "cl.block_x, cl.sub_x", []);

    private List<CellLocationSummary> CellLocations(
        PluginAddress plugin, string where, string blockOrder, IEnumerable<string> parameters)
    {
        using var connection = store.OpenReadConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            WITH RECURSIVE {NavigatorSql.AboveAFailure("records", "WHERE h.plugin = $1 AND h.origin = $2")}
            SELECT cl.cell_form_key, c.editor_id, cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y,
                   {FullNameOf("c")}, c.parse_diagnosis,
                   c.parse_diagnosis IS NOT NULL OR EXISTS (
                       SELECT 1 FROM above_failure a
                       WHERE a.form_key = cl.cell_form_key AND a.plugin = cl.plugin AND a.origin = cl.origin
                   ),
                   EXISTS (
                       SELECT 1 FROM ({NavigatorSql.CellChildren}) p
                       JOIN records pr ON pr.form_key = p.form_key AND pr.plugin = p.plugin AND pr.origin = p.origin
                       WHERE p.parent_cell = cl.cell_form_key AND p.plugin = cl.plugin AND p.origin = cl.origin
                         {store.Filter.AlsoKeeps("p")}
                   )
            FROM cell_location cl
            LEFT JOIN records c ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
            WHERE cl.plugin = $1 AND cl.origin = $2 AND {where}{store.Filter.AlsoKeeps("cl", "cell_form_key")}
            ORDER BY {blockOrder}, {NavigatorSql.FormIdOrder("cl.cell_form_key")}
            """;
        DuckDbSql.AddParams(cmd, [plugin.Name, plugin.Origin, .. parameters]);
        using var reader = cmd.ExecuteReader();

        int? NullableInt(int i) => reader.IsDBNull(i) ? null : reader.GetInt32(i);
        var rows = new List<CellLocationSummary>();
        while (reader.Read())
        {
            rows.Add(new CellLocationSummary(
                reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                NullableInt(2), NullableInt(3), NullableInt(4), NullableInt(5), NullableInt(6), NullableInt(7),
                FullName: reader.IsDBNull(8) ? null : reader.GetString(8),
                ParseDiagnosis: reader.IsDBNull(9) ? null : reader.GetString(9),
                HasParseFailure: reader.GetBoolean(10),
                HasChildren: reader.GetBoolean(11)));
        }

        return rows;
    }

    public IReadOnlySet<string> GetWorldspacesHoldingCells(PluginAddress plugin)
    {
        using var connection = store.OpenReadConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT DISTINCT cl.parent_worldspace FROM cell_location cl
            WHERE cl.parent_worldspace IS NOT NULL AND cl.plugin = $1 AND cl.origin = $2{store.Filter.AlsoKeeps("cl", "cell_form_key")}
            """;
        DuckDbSql.AddParams(cmd, [plugin.Name, plugin.Origin]);
        using var reader = cmd.ExecuteReader();

        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (reader.Read()) result.Add(reader.GetString(0));
        return result;
    }

    public CellChildRecords GetCellChildRecords(PluginAddress plugin, string cellFormKey)
    {
        var schemas = store.Schemas;
        var cellChildTypes = CellChildTypeNames.Where(schemas.ContainsKey).ToList();
        if (cellChildTypes.Count == 0)
            return new CellChildRecords([], []);

        using var connection = store.OpenReadConnection();

        // ADR-0005: the placed ref's base form comes out of the document rather than a
        // `base` column; json_extract_string unquotes the stored FormLink text, and a placed ref
        // with no base reads NULL.
        var typeList = string.Join(", ", cellChildTypes.Select(t => $"'{t}'"));

        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT p.placement_group, r.record_type, p.form_key, r.editor_id,
                   json_extract_string(r.body, '$.Base'), r.parse_diagnosis IS NOT NULL, {FullNameOf("r")},
                   r.parse_diagnosis,
                   -- The base record's EditorID (plugins.md, Record). Its copy in the reference's own plugin, else the winning copy.
                   (SELECT b.editor_id FROM records b
                    WHERE b.form_key = json_extract_string(r.body, '$.Base')
                    ORDER BY (b.plugin = r.plugin AND b.origin = r.origin) DESC, b.is_winner DESC, b.plugin, b.origin
                    LIMIT 1)
            FROM ({NavigatorSql.CellChildren}) p
            JOIN records r ON r.form_key = p.form_key AND r.plugin = p.plugin AND r.origin = p.origin
            WHERE p.parent_cell = $1 AND p.plugin = $2 AND p.origin = $3
              AND r.record_type IN ({typeList}){store.Filter.AlsoKeeps("p")}
            ORDER BY {NavigatorSql.FormIdOrder("p.form_key")}
            """;
        DuckDbSql.AddParams(cmd, [cellFormKey, plugin.Name, plugin.Origin]);
        using var reader = cmd.ExecuteReader();

        var persistent = new List<ChildRecordSummary>();
        var temporary = new List<ChildRecordSummary>();
        while (reader.Read())
        {
            var group = reader.GetString(0);
            var summary = new ChildRecordSummary(
                reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetString(1),
                HasParseFailure: reader.GetBoolean(5),
                FullName: reader.IsDBNull(6) ? null : reader.GetString(6),
                ParseDiagnosis: reader.IsDBNull(7) ? null : reader.GetString(7),
                BaseEditorId: reader.IsDBNull(8) ? null : reader.GetString(8));
            (group == "persistent" ? persistent : temporary).Add(summary);
        }
        return new CellChildRecords(persistent, temporary);
    }

    public PlacementRow? GetPlacement(string formKey, PluginAddress plugin)
    {
        using var connection = store.OpenReadConnection();
        return GetPlacement(connection, formKey, plugin.Name, plugin.Origin);
    }

    public CellLocationRow? GetCellLocation(PluginAddress plugin, string cellFormKey)
    {
        using var connection = store.OpenReadConnection();
        return GetCellLocation(connection, cellFormKey, plugin.Name, plugin.Origin);
    }

    public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginAddress plugin, string parentFormKey)
    {
        using var connection = store.OpenReadConnection();
        return GetContainerChildren(
            connection, plugin.Name, plugin.Origin, parentFormKey, store.Filter.AlsoKeeps("cc", "child_form_key"), NavigatorSql.FormIdOrder("cc.child_form_key"));
    }

    public ContainerChildRow? GetContainerParent(PluginAddress plugin, string childFormKey)
    {
        using var connection = store.OpenReadConnection();
        return GetContainerParent(connection, plugin.Name, plugin.Origin, childFormKey);
    }

    // Column 6 is the row's working_tree_state, 7 the correlated container_child EXISTS Search's
    // SELECT adds, 8 this record's own diagnosis, 9 the same fact widened to its children and 10
    // its FULL, read positionally.
    private static RecordSummary ReadSummary(DuckDBDataReader reader) =>
        new(reader.GetString(0), reader.GetString(1), LoadOrderSortKey(reader, 2),
            reader.GetBoolean(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetString(5),
            WorkingTreeStates.FromStored(reader.GetString(6)), reader.GetBoolean(7),
            reader.IsDBNull(8) ? null : reader.GetString(8), reader.GetBoolean(9),
            FullName: reader.IsDBNull(10) ? null : reader.GetString(10));

    private static string FullNameOf(string alias) =>
        $"NULLIF({TranslatedStringSql.Resolved($"{alias}.body", "$.Name")}, '')";

    // The callers hold ADR-0012, not this builder: RecordQueryService's
    // RecordFilterGuard refuses a plugin without its origin, and every other caller passes both
    // or neither.
    private static (string where, List<string> paramValues) BuildWhere(
        string? plugin, string? search, string? filterCondition = null, string? origin = null,
        IReadOnlyList<string>? recordTypes = null, string? groupCondition = null, string? searchFormKey = null)
    {
        var conditions = new List<string>();
        var values = new List<string>();

        if (recordTypes is { Count: > 0 })
        {
            var placeholders = recordTypes.Select((_, i) => $"${values.Count + i + 1}");
            conditions.Add($"record_type IN ({string.Join(", ", placeholders)})");
            values.AddRange(recordTypes.Select(NormalizeRecordType));
        }

        if (plugin != null)
        {
            conditions.Add($"plugin = ${values.Count + 1}");
            values.Add(plugin);
        }
        if (origin != null)
        {
            conditions.Add($"origin = ${values.Count + 1}");
            values.Add(origin);
        }
        if (search != null)
        {
            // A FormKey-shaped query resolves against form_key rather than an EditorID substring
            // match; form_key values are stored via FormKey.ToString(), so round-tripping the
            // query through TryFactory canonicalizes its hex id.
            var matches = new List<string>();
            if (Mutagen.Bethesda.Plugins.FormKey.TryFactory(search, out var formKey))
            {
                matches.Add($"form_key = ${values.Count + 1}");
                values.Add(formKey.ToString());
            }
            else
            {
                matches.Add($"editor_id ILIKE ${values.Count + 1}");
                values.Add($"%{search}%");
            }
            if (searchFormKey != null)
            {
                matches.Add($"form_key = ${values.Count + 1}");
                values.Add(searchFormKey);
            }
            conditions.Add($"({string.Join(" OR ", matches)})");
        }
        if (filterCondition != null)
            conditions.Add(filterCondition);
        if (groupCondition != null)
            conditions.Add(groupCondition);

        var where = conditions.Count > 0 ? " WHERE " + string.Join(" AND ", conditions) : "";
        return (where, values);
    }

    // Private: table-name dispatch is rejected from the seam; GetDocument and GetOverrideStack
    // resolve a FormKey's type themselves rather than being told it.
    private static string? FindRecordType(DuckDBConnection connection, string formKey)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT record_type FROM records WHERE form_key = $1 LIMIT 1";
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        return cmd.ExecuteScalar() as string;
    }

    private static List<ReferenceRow> GetReferences(DuckDBConnection connection, string targetFormKey)
    {
        // WorkingTreeOverlay keeps form_references rewritten as the working tree changes, so this
        // already sees every edit without applying anything itself.
        const string sql = """
            SELECT fr.source_form_key, fr.source_plugin, fr.field_path, fr.record_type, fr.editor_id, fr.source_origin
            FROM form_references fr
            WHERE fr.target_form_key = $1
            """;

        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        DuckDbSql.AddParams(cmd, [targetFormKey]);

        var results = new List<ReferenceRow>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            results.Add(new ReferenceRow(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetString(5)));
        }

        return results;
    }

    // ── Worldspace tree reads (plugins.md, The tree, story 6) ───────────────────

    private static PlacementRow? GetPlacement(DuckDBConnection connection, string formKey, string plugin, string origin)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = """
            SELECT parent_cell, placement_group, pos_x, pos_y, pos_z
            FROM placement
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """;
        DuckDbSql.AddParams(cmd, [formKey, plugin, origin]);
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

    private static CellLocationRow? GetCellLocation(DuckDBConnection connection, string cellFormKey, string plugin, string origin)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = """
            SELECT parent_worldspace, block_x, block_y, sub_x, sub_y, grid_x, grid_y, is_interior
            FROM cell_location
            WHERE cell_form_key = $1 AND plugin = $2 AND origin = $3
            """;
        DuckDbSql.AddParams(cmd, [cellFormKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        int? NullableInt(int i) => reader.IsDBNull(i) ? null : reader.GetInt32(i);
        if (!reader.Read()) return null;

        var parentWorldspace = reader.IsDBNull(0) ? null : reader.GetString(0);
        return new CellLocationRow(
            cellFormKey, parentWorldspace,
            NullableInt(1), NullableInt(2), NullableInt(3), NullableInt(4), NullableInt(5), NullableInt(6),
            reader.GetBoolean(7));
    }

    private static List<ContainerChildRow> GetContainerChildren(
        DuckDBConnection connection, string plugin, string origin, string parentFormKey, string inFilter, string order)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT cc.child_form_key, cc.parent_record_type, cc.slot_name, cc.slot_index
            FROM container_child cc
            WHERE cc.parent_form_key = $1 AND cc.plugin = $2 AND cc.origin = $3{inFilter}
            ORDER BY {order}
            """;
        DuckDbSql.AddParams(cmd, [parentFormKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        var result = new List<ContainerChildRow>();
        while (reader.Read())
        {
            result.Add(new ContainerChildRow(
                reader.GetString(0), parentFormKey, reader.GetString(1), reader.GetString(2), reader.GetInt32(3)));
        }
        return result;
    }

    private static ContainerChildRow? GetContainerParent(DuckDBConnection connection, string plugin, string origin, string childFormKey)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = """
            SELECT parent_form_key, parent_record_type, slot_name, slot_index
            FROM container_child
            WHERE child_form_key = $1 AND plugin = $2 AND origin = $3
            """;
        DuckDbSql.AddParams(cmd, [childFormKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        return reader.Read()
            ? new ContainerChildRow(
                childFormKey, reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetInt32(3))
            : null;
    }

    private RecordDocument? ReadDocument(DuckDBConnection connection, string tableName, string formKey, string? plugin, string? origin, bool winnerOnly)
    {
        var schema = store.Schemas[tableName];
        var conditions = new List<string> { "form_key = $1" };
        var values = new List<string> { formKey };

        if (winnerOnly) conditions.Add("is_winner = true");
        if (plugin != null) { conditions.Add($"plugin = ${values.Count + 1}"); values.Add(plugin); }
        if (origin != null) { conditions.Add($"origin = ${values.Count + 1}"); values.Add(origin); }

        conditions.Add($"record_type = ${values.Count + 1}");
        values.Add(NormalizeRecordType(tableName));

        var resolve = LinkResolution.ForLinksOf(connection, formKey);
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, parse_diagnosis
            FROM records WHERE {string.Join(" AND ", conditions)}
            LIMIT 1
            """;
        DuckDbSql.AddParams(cmd, values);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;

        return ReadDocumentFromBody(reader, schema, resolve);
    }

    private RecordDocument ReadDocumentFromBody(
        DuckDBDataReader reader, RecordTableSchema schema, Func<string, RecordLookupEntry?> resolveFormKey) =>
        DocumentFromBody(
            reader.GetString(0), reader.GetString(1), reader.GetString(2), LoadOrderSortKey(reader, 3),
            reader.GetBoolean(4), reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.GetString(6), schema, resolveFormKey, reader.IsDBNull(7) ? null : reader.GetString(7));

    // The construction half of ReadDocumentFromBody, split out so the bulk read can build documents
    // from rows materialized before reading any. The fields are the document's own nodes at each
    // column's path (ADR-0005): nothing is reconstituted.
    private RecordDocument DocumentFromBody(
        string formKey, string plugin, string origin, int loadOrderIndex, bool isWinner,
        string? editorId, string body, RecordTableSchema schema,
        Func<string, RecordLookupEntry?> resolveFormKey, string? parseDiagnosis)
    {
        using var parsed = JsonDocument.Parse(body);
        var root = parsed.RootElement;

        return new RecordDocument(
            formKey, new PluginAddress(plugin, origin), loadOrderIndex, isWinner, editorId, schema.TableName,
            body, BuildFields(schema, root, resolveFormKey, store.Release),
            // A ModHeader cannot carry the Partial Form flag.
            IsPartialForm: !schema.IsHeader && PartialFormFlag.IsSet(root, schema.RecordType),
            ParseDiagnosis: parseDiagnosis);
    }

    private static List<FieldValue> BuildFields(
        RecordTableSchema schema, JsonElement root,
        Func<string, RecordLookupEntry?> resolveFormKey, GameRelease release)
    {
        ResolvedFormKey? Resolve(string formKey) =>
            resolveFormKey(formKey) is { } entry ? new ResolvedFormKey(entry.RecordType, entry.EditorId) : null;

        var fields = new List<FieldValue>(schema.RecordColumns.Count);
        foreach (var col in schema.RecordColumns)
        {
            // A synthetic member is the bit it stands for, read off the member the document spells.
            var value = col.Synthetic is { } bit
                ? JsonSerializer.SerializeToElement(SyntheticBits.IsSet(root, bit))
                : DocumentNodes.At(root, col.PropertyName);
            var meta = col.ToFieldMetadata();
            // The check reads the shape this record's own class gives the column; the wire keeps the
            // column's whole metadata, variants included, so the editor can pick the same.
            fields.Add(new FieldValue(meta, value, CheckErrorBuilder.Build(DocumentNodes.VariantFor(meta, root), value, Resolve, release)));
        }
        return fields;
    }

    private static int LoadOrderSortKey(DuckDBDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? int.MaxValue : reader.GetInt32(ordinal);

    // Callers say both "NPC_" and "npc_", and as a column value the comparison is case-sensitive.
    // Schema keys are RecordType.Type.ToLowerInvariant(), so lowercasing is an exact normalization,
    // applied wherever a caller-supplied type is bound.
    private static string NormalizeRecordType(string recordType) => recordType.ToLowerInvariant();
}
