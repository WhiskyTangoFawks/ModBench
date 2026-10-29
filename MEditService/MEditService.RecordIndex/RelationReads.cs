using System.Data.Common;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Store;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex;

/// <summary>Every read the record index answers, over the Store's relations (ADR-0010). A record read sees
/// only the active plugins (ADR-0012), unless it names one plugin and returns that plugin's copy.</summary>
internal sealed class RelationReads(
    Store.Store store, Func<IReadOnlyDictionary<PluginAddress, PluginContent>> openedPlugins, Func<bool> indexed)
{
    /// <summary>What the Index read out of each plugin it has open, keyed by identity. A plugin it has
    /// not reached, or could not open, is absent, so this is also "which plugins are open?".
    /// </summary>
    public IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins => openedPlugins();

    /// <summary>The winning override of <paramref name="formKey"/>, across every active
    /// plugin. Null if the FormKey isn't indexed.</summary>
    public RecordDocument? GetDocument(string formKey)
    {
        using var context = store.OpenRead();
        var tableName = FindRecordType(context, formKey);
        return tableName == null ? null : ReadDocument(context, tableName, formKey, plugin: null, origin: null, winnerOnly: true);
    }

    /// <summary>One specific plugin's copy of <paramref name="formKey"/>, winner or not. Null if
    /// that plugin never indexed this FormKey.</summary>
    public RecordDocument? GetDocument(string formKey, PluginAddress plugin)
    {
        using var context = store.OpenRead();
        var tableName = FindRecordType(context, formKey);
        return tableName == null ? null : ReadDocument(context, tableName, formKey, plugin.Name, plugin.Origin, winnerOnly: false);
    }

    /// <summary>The copy <paramref name="plugin"/> would hold were its document <paramref name="text"/>,
    /// active or not. Null if no plugin indexes the FormKey. Text that is no record document gives
    /// a copy with a <c>ParseDiagnosis</c>.</summary>
    public RecordDocument? DocumentFromText(string formKey, PluginAddress plugin, int loadOrderIndex, string text)
    {
        using var context = store.OpenRead();
        var tableName = FindRecordTypeInAnyPlugin(context, formKey);
        if (tableName == null) return null;
        var (body, editorId, parseDiagnosis) = CallerText.Read(text);
        return DocumentFromBody(
            context, formKey, plugin.Name, plugin.Origin, loadOrderIndex, isWinner: false, editorId, body,
            store.Schemas[tableName], LinkResolution.ForLinksOf(context, formKey, Resolve), parseDiagnosis);
    }

    /// <summary>What <paramref name="plugin"/> holds <paramref name="formKey"/> as, and its document as
    /// the record index stores it, active or not. Null if that plugin never indexed it.</summary>
    public (RecordIdentity Identity, string Body)? GetCopyText(string formKey, PluginAddress plugin)
    {
        using var context = store.OpenRead();
        return context.Rows($"SELECT record_type, editor_id, body FROM {TableDdlBuilder.PluginRecordsView} WHERE form_key = $1 AND plugin = $2 AND origin = $3 LIMIT 1",
            reader => (new RecordIdentity(formKey, reader.GetString(0), reader.GetStringOrNull(1)), reader.GetString(2)),
            formKey, plugin.Name, plugin.Origin) is [var copy] ? copy : null;
    }

    /// <summary>Whether any registered plugin, active or not, holds <paramref name="formKey"/>.</summary>
    public bool IsHeldByAnyPlugin(string formKey)
    {
        using var context = store.OpenRead();
        return context.Scalar<bool>($"SELECT EXISTS (SELECT 1 FROM {TableDdlBuilder.PluginRecordsView} WHERE form_key = $1)", formKey);
    }

    /// <summary>The records a name can mean: the one whose FormKey it is, and every one whose winning copy's
    /// EditorID it is, whatever the case. A record no active plugin holds is read from its first copy.</summary>
    public IReadOnlyList<(string FormKey, string? EditorId)> RecordsNamed(string name)
    {
        using var context = store.OpenRead();
        var formKey = CanonicalFormKey.Of(name);
        return context.Rows($"""
            SELECT form_key, editor_id FROM (
                SELECT form_key, editor_id FROM {TableDdlBuilder.PluginRecordsView}
                QUALIFY row_number() OVER (PARTITION BY form_key ORDER BY is_winner DESC, plugin, origin) = 1)
            WHERE lower(editor_id) = lower($1) OR form_key = $2
            ORDER BY form_key
            """,
            reader => (reader.GetString(0), reader.GetStringOrNull(1)),
            name, formKey);
    }

    /// <summary>Every plugin's copy of <paramref name="formKey"/>, in load order. Null if the
    /// FormKey isn't indexed anywhere.</summary>
    public OverrideStack? GetOverrideStack(string formKey)
    {
        using var context = store.OpenRead();
        var tableName = FindRecordType(context, formKey);
        if (tableName == null) return null;
        var schema = store.Schemas[tableName];
        var resolve = LinkResolution.ForLinksOf(context, formKey);
        var entries = context.Rows("""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, parse_diagnosis, working_tree_state
            FROM records
            WHERE form_key = $1 AND record_type = $2
            ORDER BY load_order_idx
            """, reader =>
        {
            var doc = ReadDocumentFromBody(context, reader, schema, resolve);
            var isDirty = WorkingTreeStates.FromStored(reader.GetString(8)) != WorkingTreeState.None;
            return new OverrideStackEntry(doc.Plugin, doc.LoadOrderIndex, doc.IsWinner, doc, isDirty);
        }, formKey, NormalizeRecordType(tableName));

        return entries.Count == 0 ? null : new OverrideStack(formKey, tableName, entries);
    }

    public PagedResult<RecordSummary> Search(RecordQuery query)
    {
        using var context = store.OpenRead();
        var filter = query.Scope == RecordQueryScope.Navigator ? store.Filter : null;
        var scope = query is { Scope: RecordQueryScope.Search, Plugin: not null } ? RecordScope.EveryRegisteredPlugin : RecordScope.Active;
        var (where, paramValues) = BuildWhere(
            query.Plugin?.Name, query.Search, filter?.Listing, query.Origin, query.RecordTypes, query.SearchFormKey);
        var unheld = query.GroupOnly ? NavigatorSql.Unheld("r") : "";
        var dataParams = new List<string>(paramValues);
        var holdings = HoldingsOf(query.Plugin?.Name, query.Origin, dataParams);
        var cols = $"""
            form_key, plugin, load_order_idx, is_winner, editor_id, origin, r.working_tree_state,
            EXISTS (
                SELECT 1 FROM {NavigatorSql.ContainerChildren} cc
                WHERE cc.parent = r.form_key AND cc.plugin = r.plugin AND cc.origin = r.origin
                  {filter?.AlsoKeeps("cc", "child")}
            ) AS has_container_children,
            r.parse_diagnosis,
            r.parse_diagnosis IS NOT NULL OR EXISTS (
                SELECT 1 FROM above_failure a
                WHERE a.form_key = r.form_key AND a.plugin = r.plugin AND a.origin = r.origin
            ) AS has_parse_failure,
            {FullNameOf("r")} AS full_name
            """;

        var total = context.Scalar<long>($"WITH {NavigatorSql.HeldFor(scope, holdings)} SELECT COUNT(*) FROM {scope.Records} r{unheld}{where}", [.. dataParams]);

        // xEdit's navigator lists a group in FormID order, and its record picker lists by EditorID.
        // (plugin, origin) makes either order total, so LIMIT/OFFSET pages stably.
        var order = query.GroupOnly ? NavigatorSql.FormIdOrder("r.form_key_plugin", "r.form_key") : "editor_id, form_key";
        var items = context.Rows($"""
            WITH RECURSIVE {NavigatorSql.AboveAFailure(scope, holdings)}
            SELECT {cols} FROM {scope.Records} r{unheld}{where}
            ORDER BY {order}, plugin, origin
            LIMIT {query.Limit} OFFSET {query.Offset}
            """, ReadSummary, [.. dataParams]);

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

    /// <summary>The rows of one SELECT over the views of every plugin the record index holds, each a JSON object of its
    /// columns; or why the SQL cannot be one. The filter in force does not narrow it.</summary>
    public Answer<JsonElement[], string> Select(string statement)
    {
        var sql = statement.TrimEnd().TrimEnd(';');
        using var context = store.OpenRead();
        if (SqlDoor.RefusalOf(context, sql, TableDdlBuilder.IndexedSchema) is { } refusal) return refusal;
        try
        {
            context.Execute($"SET search_path = '{TableDdlBuilder.IndexedSchema}'");
            // The newline keeps a trailing line comment in the SQL from swallowing the wrapper.
            return context.Rows($"SELECT to_json(__row) FROM ({sql}\n) __row",
                reader => JsonDocument.Parse(reader.GetString(0)).RootElement.Clone()).ToArray();
        }
        catch (IndexFaultException ex) when (ex.Fault is IndexFault.Refused or IndexFault.RowValue)
        {
            return ex.Message;
        }
    }

    /// <summary>Row count per record type for one plugin, narrowed by the filter as Search is
    /// (SetFilter never affects a point read).</summary>
    public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginAddress plugin)
    {
        using var context = store.OpenRead();
        var (where, paramValues) = BuildWhere(
            plugin.Name, null, store.Filter.Listing, plugin.Origin);
        var holdings = HoldingsOf(plugin.Name, plugin.Origin, paramValues);
        var counts = context.Rows($"""
            WITH {NavigatorSql.HeldFor(RecordScope.Active, holdings)}
            SELECT record_type, COUNT(*), BOOL_OR(parse_diagnosis IS NOT NULL)
            FROM records r{NavigatorSql.Unheld("r")}{where}
            GROUP BY record_type
            """, reader => new RecordTypeCount(reader.GetString(0), (int)reader.GetInt64(1), reader.GetBoolean(2)), [.. paramValues]);

        // Merged in C# rather than joined: a type whose enumeration failed can have no rows
        // at all, so it is absent from the GROUP BY above and would vanish from the tree.
        var failedTypes = FailedRecordTypes(context, plugin);
        var holdingAFailure = TypesHoldingAFailure(context, plugin);
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
    private static HashSet<string> TypesHoldingAFailure(ReadContext context, PluginAddress plugin)
    {
        var types = context.Rows($"""
            WITH RECURSIVE {NavigatorSql.AboveAFailure(RecordScope.Active, "WHERE h.plugin = $1 AND h.origin = $2")}
            SELECT DISTINCT r.record_type FROM records r
            JOIN above_failure a ON a.form_key = r.form_key AND a.plugin = r.plugin AND a.origin = r.origin{NavigatorSql.Unheld("r")}
            WHERE r.plugin = $1 AND r.origin = $2
            """, reader => reader.GetString(0), plugin.Name, plugin.Origin);
        return new HashSet<string>(types, StringComparer.OrdinalIgnoreCase);
    }

    // Unfiltered: a record filter narrows what is listed, never whether a type could be read.
    private static HashSet<string> FailedRecordTypes(ReadContext context, PluginAddress plugin)
    {
        var types = context.Rows("SELECT DISTINCT record_type FROM record_type_failure WHERE plugin = $1 AND origin = $2",
            reader => reader.GetString(0), plugin.Name, plugin.Origin);
        return new HashSet<string>(types, StringComparer.OrdinalIgnoreCase);
    }

    // A group holds its listed records' own states and what is beneath them; a record only what is
    // beneath it. The header lists in no group.
    public WorkingTreeStatesBeneath GetWorkingTreeStatesBeneath(PluginAddress plugin)
    {
        var scope = RecordScope.Active;
        using var context = store.OpenRead();
        var states = context.Rows($"""
            WITH RECURSIVE {NavigatorSql.AboveAChange(scope, "WHERE h.plugin = $1 AND h.origin = $2", store.Filter.AlsoKeeps("f"))}
            SELECT FALSE AS is_group, form_key AS row_key, fact AS state FROM above_change
            UNION
            SELECT TRUE, r.record_type, r.working_tree_state FROM {scope.Records} r{NavigatorSql.Unheld("r")}
            WHERE r.plugin = $1 AND r.origin = $2 AND r.working_tree_state <> '{WorkingTreeState.None.Stored()}'
              AND r.record_type <> '{PluginHeader.RecordType}'{store.Filter.AlsoKeeps("r")}
            UNION
            SELECT TRUE, r.record_type, a.fact FROM above_change a
            JOIN {scope.Records} r ON r.form_key = a.form_key AND r.plugin = a.plugin AND r.origin = a.origin{NavigatorSql.Unheld("r")}
            -- above_change holds only the plugin's rows, but the engine pushes none of it into records.
            WHERE r.plugin = $1 AND r.origin = $2
            """, reader => (IsGroup: reader.GetBoolean(0), Key: reader.GetString(1), State: WorkingTreeStates.FromStored(reader.GetString(2))),
            plugin.Name, plugin.Origin);

        var byRecordType = new Dictionary<string, IReadOnlyList<WorkingTreeState>>(StringComparer.OrdinalIgnoreCase);
        var byRecord = new Dictionary<string, IReadOnlyList<WorkingTreeState>>(StringComparer.Ordinal);
        foreach (var (isGroup, key, state) in states)
        {
            var rows = isGroup ? byRecordType : byRecord;
            rows[key] = [.. rows.GetValueOrDefault(key, []).Append(state).Order()];
        }
        return new WorkingTreeStatesBeneath(
            [.. byRecordType.Values.SelectMany(states => states).Distinct().Order()], byRecordType, byRecord);
    }

    private RecordLookupEntry? Resolve(string formKey)
    {
        using var context = store.OpenRead();
        return LinkResolution.Resolve(context, formKey);
    }

    /// <summary>One response's FormKey → (record type, EditorID) lookup against the winning override,
    /// about <paramref name="formKey"/>, each distinct FormKey asked once. The store resolves the
    /// links its copies carry in one query up front.</summary>
    public Func<string, RecordLookupEntry?> LinkResolver(string formKey)
    {
        using var context = store.OpenRead();
        return LinkResolution.ForLinksOf(context, formKey, Resolve);
    }

    private List<MissingReference> GetReferencesToMissingRecords()
    {
        using var context = store.OpenRead();
        var release = store.Release;
        return context.Rows($"""
            SELECT fr.source_plugin, fr.source_origin, fr.source_form_key, fr.record_type, fr.editor_id,
                   fr.target_form_key, fr.field_path
            FROM {TableDdlBuilder.MirrorSchema}.form_references fr
            {TableDdlBuilder.RegisteredJoin("fr", "source_plugin", "source_origin")}
            JOIN {TableDdlBuilder.MirrorSchema}.{TableDdlBuilder.PluginDerivationTable} d
              ON d.plugin = fr.source_plugin AND d.origin = fr.source_origin AND d.derived_from = '{DerivedFrom.SourceTree}'
            WHERE NOT EXISTS (SELECT 1 FROM form_lookup l WHERE l.form_key = fr.target_form_key)
              AND NOT EXISTS (
                  SELECT 1 FROM {TableDdlBuilder.MirrorSchema}.records own
                  WHERE own.form_key = fr.target_form_key
                    AND own.plugin = fr.source_plugin AND own.origin = fr.source_origin)
            ORDER BY fr.source_plugin, fr.source_origin, fr.source_form_key, fr.field_path
            """, reader => new MissingReference(
                reader.GetPluginAddress(), reader.GetString(2), reader.GetString(3),
                reader.GetStringOrNull(4), reader.GetString(5), reader.GetString(6)))
            .Where(reference => FormKeyResolution.From(reference.TargetFormKey, null, [], release).State == FormKeyResolutionState.Unresolved)
            .ToList();
    }

    /// <summary>Each link from a plugin read from its source tree to a FormKey no active plugin holds
    /// and the engine does not define, on its file in <paramref name="sourceOf"/>.</summary>
    public IReadOnlyList<MissingReferenceOnFile> GetReferencesToMissingRecordsOnFiles(
        Func<PluginAddress, ISourceRepositoryReads?> sourceOf)
    {
        var repositories = new Dictionary<PluginAddress, ISourceRepositoryReads?>(PluginAddress.Comparer);
        return
        [
            .. GetReferencesToMissingRecords().Select(reference =>
            {
                if (!repositories.TryGetValue(reference.Plugin, out var repository))
                {
                    repository = sourceOf(reference.Plugin);
                    repositories[reference.Plugin] = repository;
                }
                return repository is null
                    ? SourceFilePlacement.Unprovided(reference)
                    : SourceFilePlacement.Place(reference, repository);
            }),
        ];
    }

    public IReadOnlyList<ReferenceRow> GetReferencedBy(string targetFormKey)
    {
        using var context = store.OpenRead();
        return GetReferences(context, "form_references fr", "", targetFormKey);
    }

    private static readonly string ActiveOrCompiledPluginReferrers = $"""
        {TableDdlBuilder.MirrorSchema}.form_references fr
        {TableDdlBuilder.RegisteredJoin("fr", "source_plugin", "source_origin")}
        JOIN {TableDdlBuilder.MirrorSchema}.{TableDdlBuilder.PluginDerivationTable} d
          ON d.plugin = fr.source_plugin AND d.origin = fr.source_origin
        """;

    /// <summary>The same read over the active plugins and the inactive compiled ones (ADR-0012).</summary>
    public IReadOnlyList<ReferenceRow> GetReferencedByInActiveOrCompiledPlugins(string targetFormKey)
    {
        using var context = store.OpenRead();
        return GetReferences(context, ActiveOrCompiledPluginReferrers, $"AND (p.load_order_idx IS NOT NULL OR d.derived_from <> '{DerivedFrom.Binary}')", targetFormKey);
    }

    /// <summary>Every plugin at least one filtered record matches, restricted to
    /// <paramref name="tableNames"/> (plugins.md). Empty when no filter is active: every plugin
    /// already has matches.</summary>
    public IReadOnlySet<PluginAddress> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames)
    {
        var types = tableNames.ToList();
        if (types.Count == 0 || !store.Filter.Active)
            return new HashSet<PluginAddress>(PluginAddress.Comparer);

        using var context = store.OpenRead();

        var (where, paramValues) = BuildWhere(
            null, null, FilterMatches.Matching, origin: null, recordTypes: types);

        return new HashSet<PluginAddress>(
            context.Rows($"SELECT DISTINCT plugin, origin FROM records{where}",
                reader => reader.GetPluginAddress(), [.. paramValues]),
            PluginAddress.Comparer);
    }

    /// <summary>Every Kind B diagnosis the registered plugins' binaries prove, projected when each
    /// binary was hashed and gone with its rows: the malformed-plugin read.</summary>
    public IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses()
    {
        using var context = store.OpenRead();
        return context.Rows($"""
            SELECT plugin, origin, anchor, defect_class, tail, message
            FROM {TableDdlBuilder.PluginDiagnosisTable}
            ORDER BY plugin, origin, ordinal
            """, reader => new PluginDiagnosisRow(
                reader.GetPluginAddress(),
                new PluginDiagnosis(
                    reader.GetStringOrNull(2), reader.GetString(3), reader.GetStringOrNull(4), reader.GetString(5))));
    }

    /// <summary>What each plugin's rows took their strings from: a localized plugin read from its binary.</summary>
    public IReadOnlyDictionary<PluginAddress, string> GetStringsReads()
    {
        using var context = store.OpenRead();
        var rows = context.Rows($"SELECT plugin, origin, strings_read FROM {Store.Store.FilesRelation} WHERE strings_read IS NOT NULL",
            reader => KeyValuePair.Create(reader.GetPluginAddress(), reader.GetString(2)));
        return new Dictionary<PluginAddress, string>(rows, PluginAddress.Comparer);
    }

    /// <summary>What each registered plugin's rows were derived from. A plugin with no rows is absent.</summary>
    public IReadOnlyDictionary<PluginAddress, DerivedFrom> GetDerivations()
    {
        using var context = store.OpenRead();
        var rows = context.Rows($"SELECT plugin, origin, derived_from FROM {TableDdlBuilder.PluginDerivationTable}",
            reader => KeyValuePair.Create(
                reader.GetPluginAddress(), Enum.Parse<DerivedFrom>(reader.GetString(2))));
        return new Dictionary<PluginAddress, DerivedFrom>(rows, PluginAddress.Comparer);
    }

    /// <summary>Every plugin holding a record whose document failed or a record type whose
    /// enumeration did: the tree's "has a failure below it" for a plugin row.</summary>
    public IReadOnlySet<PluginAddress> GetPluginsWithParseFailures()
    {
        using var context = store.OpenRead();
        return new HashSet<PluginAddress>(
            context.Rows($"""
                SELECT DISTINCT r.plugin, r.origin FROM {TableDdlBuilder.MirrorSchema}.records r
                {TableDdlBuilder.RegisteredJoin("r", "plugin", "origin")}
                WHERE r.parse_diagnosis IS NOT NULL
                UNION
                SELECT DISTINCT plugin, origin FROM record_type_failure
                """, reader => reader.GetPluginAddress()),
            PluginAddress.Comparer);
    }

    // Worldspace tree reads (plugins.md, The tree, story 6) from the holdings and cell_location
    // tables, in the order xEdit's navigator lists them.
    public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginAddress plugin, string worldspaceFormKey) =>
        CellLocations(plugin, $"EXISTS ({HeldBy("cl", "$3")})", "cl.block_x, cl.block_y, cl.sub_x, cl.sub_y", [worldspaceFormKey]);

    public IReadOnlyList<CellLocationSummary> GetInteriorCells(PluginAddress plugin) =>
        CellLocations(plugin, $"NOT EXISTS ({HeldBy("cl")})", "cl.block_x, cl.sub_x", []);

    private static string HeldBy(string cell, string? parent = null) => $"""
        SELECT 1 FROM held h
        WHERE h.child = {cell}.cell_form_key AND h.plugin = {cell}.plugin AND h.origin = {cell}.origin{(parent is null ? "" : $" AND h.parent = {parent}")}
        """;

    private List<CellLocationSummary> CellLocations(
        PluginAddress plugin, string where, string blockOrder, IEnumerable<string> parameters)
    {
        using var context = store.OpenRead();
        return context.Rows($"""
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
                       WHERE p.parent_cell = cl.cell_form_key AND pr.plugin = $1 AND pr.origin = $2
                         {store.Filter.AlsoKeeps("p")}
                   ),
                   c.working_tree_state
            FROM cell_location cl
            LEFT JOIN records c ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
            WHERE cl.plugin = $1 AND cl.origin = $2 AND {where}{store.Filter.AlsoKeeps("cl", "cell_form_key")}
            ORDER BY {blockOrder}, {NavigatorSql.FormIdOrder("c.form_key_plugin", "cl.cell_form_key")}
            """, reader => new CellLocationSummary(
                reader.GetString(0),
                reader.GetStringOrNull(1),
                NullableInt(reader, 2), NullableInt(reader, 3), NullableInt(reader, 4),
                NullableInt(reader, 5), NullableInt(reader, 6), NullableInt(reader, 7),
                FullName: reader.GetStringOrNull(8),
                ParseDiagnosis: reader.GetStringOrNull(9),
                HasParseFailure: reader.GetBoolean(10),
                HasChildren: reader.GetBoolean(11),
                WorkingTreeState: WorkingTreeStates.FromStored(reader.GetString(12))),
            [plugin.Name, plugin.Origin, .. parameters]);
    }

    public IReadOnlySet<string> GetWorldspacesHoldingCells(PluginAddress plugin)
    {
        using var context = store.OpenRead();
        var parents = context.Rows($"""
            SELECT DISTINCT h.parent FROM holdings h
            JOIN cell_location cl ON cl.cell_form_key = h.child AND cl.plugin = h.plugin AND cl.origin = h.origin
            WHERE h.plugin = $1 AND h.origin = $2{store.Filter.AlsoKeeps("cl", "cell_form_key")}
            """, reader => reader.GetString(0), plugin.Name, plugin.Origin);
        return new HashSet<string>(parents, StringComparer.OrdinalIgnoreCase);
    }

    public CellChildRecords GetCellChildRecords(PluginAddress plugin, string cellFormKey)
    {
        using var context = store.OpenRead();

        // ADR-0005: the placed ref's base form comes out of the document rather than a
        // `base` column; json_extract_string unquotes the stored FormLink text, and a placed ref
        // with no base reads NULL.
        var children = context.Rows($"""
            WITH {NavigatorSql.HeldFor(RecordScope.Active, "WHERE h.plugin = $2 AND h.origin = $3")},
            children AS (
                SELECT p.placement_group, r.record_type, p.form_key, r.editor_id, json_extract_string(r.body, '$.Base') AS base,
                       r.parse_diagnosis, {FullNameOf("r")} AS full_name, r.working_tree_state, r.form_key_plugin
                FROM ({NavigatorSql.CellChildren}) p
                JOIN records r ON r.form_key = p.form_key AND r.plugin = p.plugin AND r.origin = p.origin
                WHERE p.parent_cell = $1 AND r.plugin = $2 AND r.origin = $3{store.Filter.AlsoKeeps("p")}
            ),
            -- The base record's EditorID (plugins.md, Record). Its copy in the reference's own plugin, else the winning copy.
            -- Beside the records view, not through it: the engine pushes no join key past the view's winners join.
            base_names AS (
                SELECT b.form_key, b.editor_id FROM (SELECT DISTINCT base FROM children) cb
                JOIN {TableDdlBuilder.MirrorSchema}.records b ON b.form_key = cb.base
                {TableDdlBuilder.ActiveJoin("b", "plugin", "origin")}
                {TableDdlBuilder.WinnerJoin("b", "plugin", "origin")}
                QUALIFY row_number() OVER (
                    PARTITION BY b.form_key ORDER BY (b.plugin = $2 AND b.origin = $3) DESC, w.form_key IS NOT NULL DESC, b.plugin, b.origin) = 1
            )
            SELECT c.placement_group, c.record_type, c.form_key, c.editor_id, c.base, c.parse_diagnosis IS NOT NULL, c.full_name,
                   c.parse_diagnosis, n.editor_id, c.working_tree_state
            FROM children c
            LEFT JOIN base_names n ON n.form_key = c.base
            ORDER BY {NavigatorSql.FormIdOrder("c.form_key_plugin", "c.form_key")}
            """, reader => (
                Group: reader.GetString(0),
                Summary: new ChildRecordSummary(
                    reader.GetString(2),
                    reader.GetStringOrNull(3),
                    reader.GetStringOrNull(4),
                    reader.GetString(1),
                    HasParseFailure: reader.GetBoolean(5),
                    FullName: reader.GetStringOrNull(6),
                    ParseDiagnosis: reader.GetStringOrNull(7),
                    BaseEditorId: reader.GetStringOrNull(8),
                    WorkingTreeState: WorkingTreeStates.FromStored(reader.GetString(9)))),
            cellFormKey, plugin.Name, plugin.Origin);
        return new CellChildRecords(
            [.. children.Where(child => child.Group == "persistent").Select(child => child.Summary)],
            [.. children.Where(child => child.Group != "persistent").Select(child => child.Summary)]);
    }

    /// <summary>One cell's own structural parentage, or null when it isn't a cell this plugin
    /// indexed. Ref-invariant: no gesture moves a cell.</summary>
    public CellStructure? GetCellLocation(PluginAddress plugin, string cellFormKey)
    {
        using var context = store.OpenRead();
        return GetCellLocation(context, cellFormKey, plugin.Name, plugin.Origin);
    }

    /// <summary>Everything <paramref name="parentFormKey"/> holds, placed references and cells
    /// included, in FormID order; empty when it holds nothing. Ref-invariant by construction.</summary>
    public IReadOnlyList<HoldingRow> GetHoldings(PluginAddress plugin, string parentFormKey)
    {
        using var context = store.OpenRead();
        return GetHoldings(
            context, plugin.Name, plugin.Origin, parentFormKey, store.Filter.AlsoKeeps("cc", "child"), NavigatorSql.FormIdOrder("r.form_key_plugin", "cc.child"));
    }

    /// <summary>Every child <paramref name="parentFormKey"/> holds, whatever filter is in force, by slot and
    /// place in it.</summary>
    public IReadOnlyList<HoldingRow> GetEveryHolding(PluginAddress plugin, string parentFormKey)
    {
        using var context = store.OpenRead();
        return GetHoldings(context, plugin.Name, plugin.Origin, parentFormKey, inFilter: "", "cc.slot, cc.slot_index");
    }

    // Column 6 is the row's working_tree_state, 7 the correlated holdings EXISTS Search's
    // SELECT adds, 8 this record's own diagnosis, 9 the same fact widened to its children and 10
    // its FULL, read positionally.
    private static RecordSummary ReadSummary(DbDataReader reader) =>
        new(reader.GetString(0), reader.GetString(1), NullableInt(reader, 2) ?? int.MaxValue,
            reader.GetBoolean(3), reader.GetStringOrNull(4), reader.GetString(5),
            WorkingTreeStates.FromStored(reader.GetString(6)), reader.GetBoolean(7),
            reader.GetStringOrNull(8), reader.GetBoolean(9),
            FullName: reader.GetStringOrNull(10));

    private static int? NullableInt(DbDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);

    private static string FullNameOf(string alias) =>
        $"NULLIF({TranslatedStringSql.Resolved($"{alias}.body", "$.Name")}, '')";

    // The callers hold ADR-0012, not this builder: every caller passes a plugin's name and origin
    // both or neither.
    private static (string where, List<string> paramValues) BuildWhere(
        string? plugin, string? search, string? filterCondition = null, string? origin = null,
        IReadOnlyList<string>? recordTypes = null, string? searchFormKey = null)
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
            // A FormKey-shaped query resolves against form_key rather than an EditorID substring match.
            var matches = new List<string>();
            if (CanonicalFormKey.Of(search) is { } formKey)
            {
                matches.Add($"form_key = ${values.Count + 1}");
                values.Add(formKey);
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

        var where = conditions.Count > 0 ? " WHERE " + string.Join(" AND ", conditions) : "";
        return (where, values);
    }

    // Inactive plugins are indexed too (ADR-0012): any plugin's row gives the type.
    private static string? FindRecordTypeInAnyPlugin(ReadContext context, string formKey) =>
        context.ScalarString($"SELECT record_type FROM {TableDdlBuilder.MirrorSchema}.records WHERE form_key = $1 LIMIT 1", formKey);

    // Private: table-name dispatch is rejected from the seam; GetDocument and GetOverrideStack
    // resolve a FormKey's type themselves rather than being told it.
    private static string? FindRecordType(ReadContext context, string formKey) =>
        context.ScalarString("SELECT record_type FROM records WHERE form_key = $1 LIMIT 1", formKey);

    private static List<ReferenceRow> GetReferences(ReadContext context, string referrers, string restriction, string targetFormKey)
    {
        // WorkingTreeOverlay keeps form_references rewritten as the working tree changes, so this
        // already sees every edit without applying anything itself.
        return context.Rows($"""
            SELECT fr.source_form_key, fr.source_plugin, fr.field_path, fr.record_type, fr.editor_id, fr.source_origin
            FROM {referrers}
            WHERE fr.target_form_key = $1 {restriction}
            """, reader => new ReferenceRow(
                reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
                reader.GetStringOrNull(4), reader.GetString(5)),
            targetFormKey);
    }

    private static CellStructure? GetCellLocation(ReadContext context, string cellFormKey, string plugin, string origin)
    {
        return context.Rows("""
            SELECT (SELECT h.parent FROM holdings h
                    WHERE h.child = cl.cell_form_key AND h.plugin = cl.plugin AND h.origin = cl.origin
                    LIMIT 1),
                   cl.block_x, cl.block_y, cl.sub_x, cl.sub_y
            FROM cell_location cl
            WHERE cl.cell_form_key = $1 AND cl.plugin = $2 AND cl.origin = $3
            """, reader =>
        {
            var parent = reader.GetStringOrNull(0);
            return new CellStructure(
                parent, NullableInt(reader, 1), NullableInt(reader, 2), NullableInt(reader, 3), NullableInt(reader, 4),
                IsInterior: parent is null);
        }, cellFormKey, plugin, origin) is [var structure, ..] ? structure : null;
    }

    private static List<HoldingRow> GetHoldings(
        ReadContext context, string plugin, string origin, string parentFormKey, string inFilter, string order)
    {
        return context.Rows($"""
            SELECT cc.child, cc.slot, cc.slot_index
            FROM holdings cc
            LEFT JOIN records r ON r.form_key = cc.child AND r.plugin = cc.plugin AND r.origin = cc.origin
            WHERE cc.parent = $1 AND cc.plugin = $2 AND cc.origin = $3{inFilter}
            ORDER BY {order}
            """, reader => new HoldingRow(parentFormKey, reader.GetString(0), reader.GetString(1), reader.GetInt32(2)),
            parentFormKey, plugin, origin);
    }

    private RecordDocument? ReadDocument(ReadContext context, string tableName, string formKey, string? plugin, string? origin, bool winnerOnly)
    {
        var schema = store.Schemas[tableName];
        var conditions = new List<string> { "form_key = $1" };
        var values = new List<string> { formKey };

        if (winnerOnly) conditions.Add("is_winner = true");
        if (plugin != null) { conditions.Add($"plugin = ${values.Count + 1}"); values.Add(plugin); }
        if (origin != null) { conditions.Add($"origin = ${values.Count + 1}"); values.Add(origin); }

        conditions.Add($"record_type = ${values.Count + 1}");
        values.Add(NormalizeRecordType(tableName));

        var resolve = LinkResolution.ForLinksOf(context, formKey);
        return context.Rows($"""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, parse_diagnosis
            FROM records WHERE {string.Join(" AND ", conditions)}
            LIMIT 1
            """, reader => ReadDocumentFromBody(context, reader, schema, resolve), [.. values]) is [var document] ? document : null;
    }

    private RecordDocument ReadDocumentFromBody(
        ReadContext context, DbDataReader reader, RecordTableSchema schema,
        Func<string, RecordLookupEntry?> resolveFormKey) =>
        DocumentFromBody(
            context, reader.GetString(0), reader.GetString(1), reader.GetString(2), NullableInt(reader, 3) ?? int.MaxValue,
            reader.GetBoolean(4), reader.GetStringOrNull(5),
            reader.GetString(6), schema, resolveFormKey, reader.GetStringOrNull(7));

    // The construction half of ReadDocumentFromBody. The fields are the document's own nodes (ADR-0005), except a
    // header's masters, which no document holds (ADR-0008).
    private RecordDocument DocumentFromBody(
        ReadContext context, string formKey, string plugin, string origin, int loadOrderIndex, bool isWinner,
        string? editorId, string body, RecordTableSchema schema,
        Func<string, RecordLookupEntry?> resolveFormKey, string? parseDiagnosis)
    {
        var root = Document.Parse(body);
        var address = new PluginAddress(plugin, origin);
        var missingStrings = OpenedPlugins.GetValueOrDefault(address)?.MissingStringsFiles is { Count: > 0 } files
            ? string.Join(", ", files)
            : null;
        var resolve = RecordLookupEntry.Resolver(resolveFormKey);
        var fields = schema.FieldsOf(root, resolve, store.Release, indexed(), missingStrings);

        return new RecordDocument(
            formKey, address, loadOrderIndex, isWinner, editorId, schema.TableName,
            body, schema.IsHeader ? RequiredMasters.InHeader(fields, context, address) : fields,
            IsPartialForm: schema.IsPartialForm(root),
            ParseDiagnosis: parseDiagnosis,
            MissingStringsFile: missingStrings,
            Templated: schema.TemplatedIn(root, resolve, store.Release));
    }

    // Callers say both "NPC_" and "npc_", and as a column value the comparison is case-sensitive.
    // Schema keys are RecordType.Type.ToLowerInvariant(), so lowercasing is an exact normalization,
    // applied wherever a caller-supplied type is bound.
    private static string NormalizeRecordType(string recordType) => recordType.ToLowerInvariant();
}
