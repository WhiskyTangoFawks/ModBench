using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>Every read the index answers, over the Store's relations (ADR-0010).</summary>
internal sealed class RelationReads(
    Store store, Func<IReadOnlyDictionary<PluginAddress, PluginContent>> openedPlugins) : IRecordReads
{
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

    public RecordDocument? DocumentFromText(string formKey, PluginAddress plugin, int loadOrderIndex, string text)
    {
        using var connection = store.OpenReadConnection();
        var tableName = FindRecordTypeInAnyPlugin(connection, formKey);
        if (tableName == null) return null;
        var (body, editorId, parseDiagnosis) = CallerText.Read(text);
        return DocumentFromBody(
            connection, formKey, plugin.Name, plugin.Origin, loadOrderIndex, isWinner: false, editorId, body,
            store.Schemas[tableName], LinkResolution.ForLinksOf(connection, formKey, Resolve), parseDiagnosis);
    }

    public (RecordIdentity Identity, string Body)? GetCopyText(string formKey, PluginAddress plugin)
    {
        using var connection = store.OpenReadConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT record_type, editor_id, body FROM {TableDdlBuilder.PluginRecordsView} WHERE form_key = $1 AND plugin = $2 AND origin = $3 LIMIT 1";
        DuckDbSql.AddParams(cmd, [formKey, plugin.Name, plugin.Origin]);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;
        return (new RecordIdentity(formKey, reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1)), reader.GetString(2));
    }

    public OverrideStack? GetOverrideStack(string formKey)
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
            var doc = ReadDocumentFromBody(connection, reader, schema, resolve);
            var isDirty = WorkingTreeStates.FromStored(reader.GetString(8)) != WorkingTreeState.None;
            entries.Add(new OverrideStackEntry(doc.Plugin, doc.LoadOrderIndex, doc.IsWinner, doc, isDirty));
        }

        return entries.Count == 0 ? null : new OverrideStack(formKey, tableName, entries);
    }

    public PagedResult<RecordSummary> Search(RecordQuery query)
    {
        using var connection = store.OpenReadConnection();
        var filter = query.Scope == RecordQueryScope.Navigator ? store.Filter : null;
        var scope = query is { Scope: RecordQueryScope.Search, Plugin: not null } ? RecordScope.EveryRegisteredPlugin : RecordScope.Active;
        var (where, paramValues) = BuildWhere(
            query.Plugin?.Name, query.Search, filter?.Listing, query.Origin, query.RecordTypes,
            query.GroupOnly ? NavigatorSql.NotHeld("r") : null, query.SearchFormKey);
        var dataParams = new List<string>(paramValues);
        var holdings = HoldingsOf(query.Plugin?.Name, query.Origin, dataParams);
        var cols = $"""
            form_key, plugin, load_order_idx, is_winner, editor_id, origin, r.working_tree_state,
            EXISTS (
                SELECT 1 FROM {scope.ContainerChild} cc
                WHERE cc.parent_form_key = r.form_key AND cc.plugin = r.plugin AND cc.origin = r.origin
                  {filter?.AlsoKeeps("cc", "child_form_key")}
            ) AS has_container_children,
            r.parse_diagnosis,
            r.parse_diagnosis IS NOT NULL OR EXISTS (
                SELECT 1 FROM above_failure a
                WHERE a.form_key = r.form_key AND a.plugin = r.plugin AND a.origin = r.origin
            ) AS has_parse_failure,
            {FullNameOf("r")} AS full_name
            """;

        using var countCmd = connection.CreateCommand();
        countCmd.CommandText = $"SELECT COUNT(*) FROM {scope.Records} r{where}";
        DuckDbSql.AddParams(countCmd, paramValues);
        var total = ExecuteCount(countCmd);

        // xEdit's navigator lists a group in FormID order, and its record picker lists by EditorID.
        // (plugin, origin) makes either order total, so LIMIT/OFFSET pages stably.
        var order = query.GroupOnly ? NavigatorSql.FormIdOrder("form_key") : "editor_id, form_key";
        using var dataCmd = connection.CreateCommand();
        dataCmd.CommandText = $"""
            WITH RECURSIVE {NavigatorSql.AboveAFailure(scope, holdings)}
            SELECT {cols} FROM {scope.Records} r{where}
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
            WITH RECURSIVE {NavigatorSql.AboveAFailure(RecordScope.Active, "WHERE h.plugin = $1 AND h.origin = $2")}
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

    private RecordLookupEntry? Resolve(string formKey)
    {
        using var connection = store.OpenReadConnection();
        return LinkResolution.Resolve(connection, formKey);
    }

    public Func<string, RecordLookupEntry?> LinkResolver(string formKey)
    {
        using var connection = store.OpenReadConnection();
        return LinkResolution.ForLinksOf(connection, formKey, Resolve);
    }

    private List<MissingReference> GetReferencesToMissingRecords()
    {
        using var connection = store.OpenReadConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT fr.source_plugin, fr.source_origin, fr.source_form_key, fr.record_type, fr.editor_id,
                   fr.target_form_key, fr.field_path
            FROM {TableDdlBuilder.MirrorSchema}.form_references fr
            {TableDdlBuilder.RegisteredJoin("fr", "source_plugin", "source_origin")}
            WHERE NOT EXISTS (SELECT 1 FROM form_lookup l WHERE l.form_key = fr.target_form_key)
              AND NOT EXISTS (
                  SELECT 1 FROM {TableDdlBuilder.MirrorSchema}.form_lookup own
                  WHERE own.form_key = fr.target_form_key
                    AND own.plugin = fr.source_plugin AND own.origin = fr.source_origin)
            ORDER BY fr.source_plugin, fr.source_origin, fr.source_form_key, fr.field_path
            """;

        var release = store.Release;
        var missing = new List<MissingReference>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            var target = reader.GetString(5);
            if (FormKeyResolution.From(target, null, [], release).State != FormKeyResolutionState.Unresolved) continue;
            missing.Add(new MissingReference(
                new PluginAddress(reader.GetString(0), reader.GetString(1)), reader.GetString(2), reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4), target, reader.GetString(6)));
        }
        return missing;
    }

    public IReadOnlyList<MissingReferenceOnFile> GetReferencesToMissingRecordsOnFiles(
        Func<PluginAddress, PluginProvider.FromMod?> modOf)
    {
        var repositories = new Dictionary<PluginAddress, SourceRepository>(PluginAddress.Comparer);
        return
        [
            .. GetReferencesToMissingRecords().Select(reference =>
            {
                if (modOf(reference.Plugin) is not { } mod) return SourceFilePlacement.Unprovided(reference);
                if (!repositories.TryGetValue(reference.Plugin, out var repository))
                {
                    repository = SourceRepository.Over(mod, store.Release);
                    repositories[reference.Plugin] = repository;
                }
                return SourceFilePlacement.Place(reference, repository);
            }),
        ];
    }

    public IReadOnlyList<ReferenceRow> GetReferencedBy(string targetFormKey)
    {
        using var connection = store.OpenReadConnection();
        return GetReferences(connection, RecordScope.Active, targetFormKey);
    }

    public IReadOnlyList<ReferenceRow> GetReferencedByInEveryRegisteredPlugin(string targetFormKey)
    {
        using var connection = store.OpenReadConnection();
        return GetReferences(connection, RecordScope.EveryRegisteredPlugin, targetFormKey);
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

    public IReadOnlyDictionary<PluginAddress, DerivedFrom> GetDerivations()
    {
        using var connection = store.OpenReadConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT plugin, origin, derived_from FROM {TableDdlBuilder.PluginDerivationTable}";
        using var reader = cmd.ExecuteReader();

        var derivations = new Dictionary<PluginAddress, DerivedFrom>(PluginAddress.Comparer);
        while (reader.Read())
            derivations[new PluginAddress(reader.GetString(0), reader.GetString(1))] = Enum.Parse<DerivedFrom>(reader.GetString(2));
        return derivations;
    }

    /// <summary>Both halves of "could not be read": a record whose own document failed, and a
    /// record type whose enumeration did.</summary>
    public IReadOnlySet<PluginAddress> GetPluginsWithParseFailures()
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

        var result = new HashSet<PluginAddress>(PluginAddress.Comparer);
        while (reader.Read())
            result.Add(new PluginAddress(reader.GetString(0), reader.GetString(1)));
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
            WITH RECURSIVE {NavigatorSql.AboveAFailure(RecordScope.Active, "WHERE h.plugin = $1 AND h.origin = $2")}
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
                   ),
                   c.working_tree_state
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
                HasChildren: reader.GetBoolean(11),
                WorkingTreeState: WorkingTreeStates.FromStored(reader.GetString(12))));
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
        using var connection = store.OpenReadConnection();

        // ADR-0005: the placed ref's base form comes out of the document rather than a
        // `base` column; json_extract_string unquotes the stored FormLink text, and a placed ref
        // with no base reads NULL.
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT p.placement_group, r.record_type, p.form_key, r.editor_id,
                   json_extract_string(r.body, '$.Base'), r.parse_diagnosis IS NOT NULL, {FullNameOf("r")},
                   r.parse_diagnosis,
                   -- The base record's EditorID (plugins.md, Record). Its copy in the reference's own plugin, else the winning copy.
                   (SELECT b.editor_id FROM records b
                    WHERE b.form_key = json_extract_string(r.body, '$.Base')
                    ORDER BY (b.plugin = r.plugin AND b.origin = r.origin) DESC, b.is_winner DESC, b.plugin, b.origin
                    LIMIT 1),
                   r.working_tree_state
            FROM ({NavigatorSql.CellChildren}) p
            JOIN records r ON r.form_key = p.form_key AND r.plugin = p.plugin AND r.origin = p.origin
            WHERE p.parent_cell = $1 AND p.plugin = $2 AND p.origin = $3{store.Filter.AlsoKeeps("p")}
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
                BaseEditorId: reader.IsDBNull(8) ? null : reader.GetString(8),
                WorkingTreeState: WorkingTreeStates.FromStored(reader.GetString(9)));
            (group == "persistent" ? persistent : temporary).Add(summary);
        }
        return new CellChildRecords(persistent, temporary);
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

    public bool HasChildRecords(PluginAddress plugin, string formKey)
    {
        using var connection = store.OpenReadConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT EXISTS (
                SELECT 1 FROM ({NavigatorSql.Held}) h WHERE h.parent = $1 AND h.plugin = $2 AND h.origin = $3)
            """;
        DuckDbSql.AddParams(cmd, [formKey, plugin.Name, plugin.Origin]);
        using var reader = cmd.ExecuteReader();
        return reader.Read() && reader.GetBoolean(0);
    }

    public IReadOnlySet<PluginAddress> PluginsHoldingChildRecords(PluginAddress plugin, string formKey)
    {
        using var connection = store.OpenReadConnection();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"""
            WITH RECURSIVE below(form_key) AS (
                SELECT h.child FROM ({NavigatorSql.Held}) h WHERE h.parent = $1 AND h.plugin = $2 AND h.origin = $3
                UNION
                SELECT h.child FROM ({NavigatorSql.Held}) h
                JOIN below b ON h.parent = b.form_key WHERE h.plugin = $2 AND h.origin = $3
            )
            SELECT DISTINCT r.plugin, r.origin FROM records r JOIN below b ON r.form_key = b.form_key
            """;
        DuckDbSql.AddParams(cmd, [formKey, plugin.Name, plugin.Origin]);
        using var reader = cmd.ExecuteReader();

        var holders = new HashSet<PluginAddress>(PluginAddress.Comparer);
        while (reader.Read()) holders.Add(new PluginAddress(reader.GetString(0), reader.GetString(1)));
        return holders;
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

    // The callers hold ADR-0012, not this builder: every caller passes a plugin's name and origin
    // both or neither.
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
                matches.Add($"contains(lower(editor_id), lower(${values.Count + 1}))");
                values.Add(search);
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

    // Inactive plugins are indexed too (ADR-0012): any plugin's row gives the type.
    private static string? FindRecordTypeInAnyPlugin(DuckDBConnection connection, string formKey)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT record_type FROM {TableDdlBuilder.MirrorSchema}.records WHERE form_key = $1 LIMIT 1";
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        return cmd.ExecuteScalar() as string;
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

    private static List<ReferenceRow> GetReferences(DuckDBConnection connection, RecordScope scope, string targetFormKey)
    {
        // WorkingTreeOverlay keeps form_references rewritten as the working tree changes, so this
        // already sees every edit without applying anything itself.
        var sql = $"""
            SELECT fr.source_form_key, fr.source_plugin, fr.field_path, fr.record_type, fr.editor_id, fr.source_origin
            FROM {scope.Referrers}
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

        return ReadDocumentFromBody(connection, reader, schema, resolve);
    }

    private RecordDocument ReadDocumentFromBody(
        DuckDBConnection connection, DuckDBDataReader reader, RecordTableSchema schema,
        Func<string, RecordLookupEntry?> resolveFormKey) =>
        DocumentFromBody(
            connection, reader.GetString(0), reader.GetString(1), reader.GetString(2), LoadOrderSortKey(reader, 3),
            reader.GetBoolean(4), reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.GetString(6), schema, resolveFormKey, reader.IsDBNull(7) ? null : reader.GetString(7));

    // The construction half of ReadDocumentFromBody. The fields are the document's own nodes (ADR-0005), except a
    // header's masters, which no document holds (ADR-0008).
    private RecordDocument DocumentFromBody(
        DuckDBConnection connection, string formKey, string plugin, string origin, int loadOrderIndex, bool isWinner,
        string? editorId, string body, RecordTableSchema schema,
        Func<string, RecordLookupEntry?> resolveFormKey, string? parseDiagnosis)
    {
        using var parsed = JsonDocument.Parse(body);
        var root = parsed.RootElement;
        var address = new PluginAddress(plugin, origin);
        var fields = schema.FieldsOf(root, RecordLookupEntry.Resolver(resolveFormKey), store.Release);

        return new RecordDocument(
            formKey, address, loadOrderIndex, isWinner, editorId, schema.TableName,
            body, schema.IsHeader ? RequiredMasters.InHeader(fields, connection, address) : fields,
            IsPartialForm: schema.IsPartialForm(root),
            ParseDiagnosis: parseDiagnosis);
    }

    private static int LoadOrderSortKey(DuckDBDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? int.MaxValue : reader.GetInt32(ordinal);

    // Callers say both "NPC_" and "npc_", and as a column value the comparison is case-sensitive.
    // Schema keys are RecordType.Type.ToLowerInvariant(), so lowercasing is an exact normalization,
    // applied wherever a caller-supplied type is bound.
    private static string NormalizeRecordType(string recordType) => recordType.ToLowerInvariant();
}
