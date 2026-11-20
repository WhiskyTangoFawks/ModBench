using System.Data.Common;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Store;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex;

/// <summary>Every read the record index answers, over the Store's relations (ADR-0010). A record read sees
/// only the active plugins (ADR-0012), unless it names one plugin and returns that plugin's copy.</summary>
internal sealed class RelationReads(
    Store.Store store, Func<IReadOnlyDictionary<PluginAddress, PluginContent>> openedPlugins, Func<bool> indexed,
    bool inOneSnapshot = false, CancellationToken cancel = default) : IDisposable
{
    private ReadContext? _snapshot;

    /// <summary>These reads for one caller, each stopping once <paramref name="caller"/> is cancelled. With
    /// <paramref name="inOneSnapshot"/>, every one is on the snapshot the first of them takes, until disposed: a read made
    /// of several of them.</summary>
    public RelationReads ForCaller(CancellationToken caller, bool inOneSnapshot = false) =>
        new(store, openedPlugins, indexed, inOneSnapshot, caller);

    public void Dispose() => _snapshot?.Dispose();

    private ReadContext OpenRead()
    {
        if (!inOneSnapshot) return store.OpenRead(cancel);
        _snapshot ??= store.OpenRead(cancel);
        return _snapshot.Borrowed();
    }

    /// <summary>What the Index read out of each plugin it has open, keyed by identity. A plugin it has
    /// not reached, or could not open, is absent, so this is also "which plugins are open?".
    /// </summary>
    public IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins => openedPlugins();

    public IReadOnlyList<PluginAddress> GetOwners(string formKey)
    {
        using var context = OpenRead();
        return context.Rows($"""
            WITH winner AS (SELECT plugin, origin FROM records WHERE form_key = $1 AND is_winner)
            SELECT plugin, origin FROM winner
            UNION ALL
            SELECT r.plugin, r.origin FROM {Copies}
            WHERE r.form_key = $1 AND {InPluginSource} AND NOT EXISTS (SELECT 1 FROM winner)
            ORDER BY plugin, origin
            """, reader => reader.GetPluginAddress(), formKey);
    }

    private static readonly string Active = TableDdlBuilder.ActiveJoin("r", "plugin", "origin");
    private static readonly string Registered = TableDdlBuilder.RegisteredJoin("r", "plugin", "origin");

    private static List<CopySize> Located(ReadContext context, string scope, string where, params object?[] values) =>
        context.Rows($"""
            SELECT r.form_key, r.plugin, r.origin, r.document_length, r.copy_id
            FROM (SELECT form_key, plugin, origin, document_length, copy_id FROM {TableDdlBuilder.MirrorSchema}.records WHERE {where}) r
            {scope}
            ORDER BY p.load_order_idx
            """, CopySizeOf, values);

    private static CopySize CopySizeOf(DbDataReader reader) =>
        new(reader.GetString(0), new PluginAddress(reader.GetString(1), reader.GetString(2)), reader.GetInt64(3), reader.GetInt64(4));

    private IEnumerable<List<StoredCopy>> Stored(ReadContext context, IEnumerable<IReadOnlyList<CopySize>> records) =>
        CopyBodies.Read(context, records, store.DocumentBatchBytes);

    /// <summary>The copy <paramref name="plugin"/> would hold were its document <paramref name="text"/>,
    /// active or not. Null if no plugin indexes the FormKey. Text that is no record document gives
    /// a copy with a <c>ParseDiagnosis</c>.</summary>
    public RecordDocument? DocumentFromText(
        string formKey, PluginAddress plugin, int loadOrderIndex, string text, LinkResolver resolver)
    {
        using var context = OpenRead();
        var tableName = FindRecordTypeInAnyPlugin(context, formKey);
        if (tableName == null) return null;
        var (body, editorId, parseDiagnosis) = CallerText.Read(text);
        LearnLinks(resolver, context, [(body, tableName)]);
        return DocumentFromBody(
            context, formKey, plugin.Name, plugin.Origin, loadOrderIndex, isWinner: false, editorId, body,
            store.Schemas[tableName], resolver.Resolve, parseDiagnosis);
    }

    /// <summary>What <paramref name="plugin"/> holds <paramref name="formKey"/> as, and its document as
    /// the record index stores it, active or not. Null if that plugin never indexed it.</summary>
    public (RecordIdentity Identity, string Body)? GetCopyText(string formKey, PluginAddress plugin)
    {
        using var context = OpenRead();
        var located = Located(context, Registered, "form_key = $1 AND plugin = $2 AND origin = $3", formKey, plugin.Name, plugin.Origin);
        if (located.Count == 0) return null;
        var copy = Stored(context, [located]).Single().Single();
        return (new RecordIdentity(formKey, copy.RecordType, copy.EditorId), copy.Body);
    }

    /// <summary>The carrying record of <paramref name="copy"/> in <paramref name="plugin"/>: the record whose own
    /// document carries it, which is the copy itself unless a container's document carries its text.</summary>
    public RecordIdentity? GetCarryingRecord(RecordIdentity copy, PluginAddress plugin)
    {
        using var context = OpenRead();
        var carrying = context.Rows($"""
            WITH RECURSIVE carried(form_key, depth) AS (
                SELECT $1, 0
                UNION ALL
                SELECT h.parent, c.depth + 1 FROM holdings h
                JOIN carried c ON h.child = c.form_key
                WHERE h.plugin = $2 AND h.origin = $3 AND {HoldingSlots.CarriedInTheParentsDocument("h.slot")}
            )
            SELECT form_key FROM carried ORDER BY depth DESC LIMIT 1
            """, reader => reader.GetString(0), copy.FormKey, plugin.Name, plugin.Origin).Single();
        if (string.Equals(carrying, copy.FormKey, StringComparison.OrdinalIgnoreCase)) return copy;
        // Found by its key alone: a join of the records to the walk reads every record's columns.
        return context.Rows(
                $"SELECT record_type, editor_id FROM {TableDdlBuilder.PluginRecordsView} WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                reader => new RecordIdentity(carrying, reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1)),
                carrying, plugin.Name, plugin.Origin)
            .FirstOrDefault();
    }

    /// <summary>Each of <paramref name="copies"/>' documents, null where that copy's plugin holds no indexed
    /// copy, and the resolver for the links of their records.</summary>
    public (List<RecordDocument?> Documents, LinkResolver Resolver) GetDocuments(IReadOnlyList<RecordCopy> copies)
    {
        var named = copies.Select((_, i) => $"(form_key = ${3 * i + 1} AND plugin = ${3 * i + 2} AND origin = ${3 * i + 3})");
        using var context = OpenRead();
        var located = Located(context, Active, string.Join(" OR ", named),
            [.. copies.SelectMany(copy => new[] { copy.FormKey, copy.Plugin.Name, copy.Plugin.Origin })]);
        var stored = Stored(context, located.GroupBy(copy => copy.FormKey, StringComparer.OrdinalIgnoreCase).Select(record => record.ToList()))
            .SelectMany(record => record).ToList();
        var resolver = NewLinkResolver();
        LearnLinks(resolver, context, stored.Select(copy => (copy.Body, copy.RecordType)));
        var held = stored.Select(copy => ReadDocumentFromBody(context, copy, resolver.Resolve))
            .ToLookup(document => document.FormKey, StringComparer.OrdinalIgnoreCase);
        return ([.. copies.Select(copy => held[copy.FormKey].FirstOrDefault(document => PluginAddress.Comparer.Equals(document.Plugin, copy.Plugin)))], resolver);
    }

    /// <summary>Each record's active copies in load order; given <paramref name="within"/>, that plugin and its masters alone
    /// (ADR-0008).</summary>
    public IEnumerable<(string FormKey, IReadOnlyList<RecordDocument> Copies)> GetStacks(IReadOnlyList<string> formKeys, PluginAddress? within)
    {
        using var context = OpenRead();
        foreach (var stack in Stored(context, CopySizes(context, formKeys, within).Select(record => record.ToList())))
            yield return (stack[0].FormKey, [.. stack.Select(copy => ReadDocumentFromBody(context, copy, _ => null))]);
    }

    private static ILookup<string, CopySize> CopySizes(ReadContext context, IReadOnlyList<string> formKeys, PluginAddress? within)
    {
        var values = new List<string>(formKeys);
        var keys = string.Join(", ", formKeys.Select((_, i) => $"${i + 1}"));
        var prefix = "";
        var narrowedByPlugin = "";
        if (within is { } judged)
        {
            var name = $"${formKeys.Count + 1}";
            var origin = $"${formKeys.Count + 2}";
            values.AddRange([judged.Name, judged.Origin]);
            prefix = $"""
                WITH RECURSIVE stack(plugin, origin) AS (
                    SELECT {name}, {origin}
                    UNION
                    SELECT a.plugin, a.origin
                    FROM stack s
                    JOIN (SELECT plugin, origin, unnest(masters) AS master FROM {TableDdlBuilder.MirrorSchema}.records) r
                      ON r.plugin = s.plugin AND r.origin = s.origin
                    JOIN {TableDdlBuilder.ActiveRelation} a ON a.plugin = r.master)
                """;
            narrowedByPlugin = "WHERE (c.plugin, c.origin) IN (SELECT plugin, origin FROM stack)";
        }
        return context.Rows($"""
            {prefix}
            SELECT c.form_key, c.plugin, c.origin, c.document_length, c.copy_id
            FROM (SELECT form_key, plugin, origin, document_length, copy_id
                  FROM {TableDdlBuilder.MirrorSchema}.records WHERE form_key IN ({keys})) c
            {TableDdlBuilder.ActiveJoin("c", "plugin", "origin")}
            {narrowedByPlugin}
            ORDER BY p.load_order_idx
            """, CopySizeOf, [.. values])
            .ToLookup(copy => copy.FormKey, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>Whether any registered plugin, active or not, holds <paramref name="formKey"/>.</summary>
    public bool IsHeldByAnyPlugin(string formKey)
    {
        using var context = OpenRead();
        return context.Scalar<bool>($"SELECT EXISTS (SELECT 1 FROM {TableDdlBuilder.PluginRecordsView} WHERE form_key = $1)", formKey);
    }

    /// <summary>The records a name can mean: the one whose FormKey it is, and every one whose winning copy's
    /// EditorID it is, whatever the case. A record no active plugin holds is read from its first copy.</summary>
    public IReadOnlyList<(string FormKey, string? EditorId)> RecordsNamed(string name)
    {
        using var context = OpenRead();
        var formKey = CanonicalFormKey.Of(name);
        const string named = "(lower(editor_id) = lower($1) OR form_key = $2)";
        var candidates = context.Rows(
            $"SELECT DISTINCT form_key FROM {TableDdlBuilder.MirrorSchema}.records WHERE {named}", reader => reader.GetString(0), name, formKey);
        if (candidates.Count == 0) return [];
        // Keys as parameters narrow the scan beneath the view's joins, where a subquery would not.
        var keys = string.Join(", ", candidates.Select((_, i) => $"${i + 3}"));
        return context.Rows($"""
            SELECT form_key, editor_id FROM (
                SELECT form_key, editor_id FROM {TableDdlBuilder.PluginRecordsView}
                WHERE form_key IN ({keys})
                QUALIFY row_number() OVER (PARTITION BY form_key ORDER BY is_winner DESC, plugin, origin) = 1)
            WHERE {named}
            ORDER BY form_key
            """,
            reader => (reader.GetString(0), reader.GetStringOrNull(1)),
            [name, formKey, .. candidates]);
    }

    /// <summary>Every plugin's copy of <paramref name="formKey"/>, in load order, of the record type the first holds.
    /// Null if the FormKey isn't indexed anywhere.</summary>
    public OverrideStack? GetOverrideStack(string formKey, LinkResolver resolver)
    {
        using var context = OpenRead();
        var located = Located(context, Active, "form_key = $1", formKey);
        if (located.Count == 0) return null;
        var stored = Stored(context, [located]).Single();
        var recordType = stored[0].RecordType;
        var copies = stored.FindAll(copy => copy.RecordType == recordType);
        LearnLinks(resolver, context, copies.Select(copy => (copy.Body, copy.RecordType)));
        var entries = copies.ConvertAll(copy =>
        {
            var doc = ReadDocumentFromBody(context, copy, resolver.Resolve);
            var isDirty = WorkingTreeStates.FromStored(copy.WorkingTreeState) != WorkingTreeState.None;
            return new OverrideStackEntry(doc.Plugin, doc.LoadOrderIndex, doc.IsWinner, doc, isDirty);
        });
        return new OverrideStack(formKey, recordType, entries);
    }

    public PagedResult<RecordSummary> Search(RecordQuery query)
    {
        using var context = OpenRead();
        var filter = query.Scope == RecordQueryScope.Navigator ? store.Filter : null;
        var scope = query is { Scope: RecordQueryScope.Search, Plugin: not null } ? RecordScope.EveryRegisteredPlugin : RecordScope.Active;
        var (where, paramValues) = BuildWhere(
            query.Plugin?.Name, query.Search, filter?.Listing, query.Origin, query.RecordTypes, query.SearchFormKey, query.FormKeys);
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
            r.full_name AS full_name
            """;


        // xEdit's navigator lists a group in FormID order, and its record picker lists by EditorID.
        // (plugin, origin) makes either order total, so LIMIT/OFFSET pages stably.
        var order = query.GroupOnly ? NavigatorSql.FormIdOrder("r.form_key_plugin", "r.form_key") : "editor_id, form_key";
        var items = context.Rows($"""
            WITH RECURSIVE {NavigatorSql.AboveAFailure(scope, holdings)}
            SELECT {cols} FROM {scope.Records} r{unheld}{where}
            ORDER BY {order}, plugin, origin
            LIMIT {query.Limit} OFFSET {query.Offset}
            """, ReadSummary, [.. dataParams]);

        var total = query.FormKeys is null
            ? (int)context.Scalar<long>($"WITH {NavigatorSql.HeldFor(scope, holdings)} SELECT COUNT(*) FROM {scope.Records} r{unheld}{where}", [.. dataParams])
            : items.Count;
        return new PagedResult<RecordSummary>(items, total);
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

    /// <summary>The rows of one SELECT over the views of every plugin the record index holds, from one snapshot; or why
    /// the SQL cannot be one. The filter in force does not narrow it.</summary>
    public Answer<SpooledRows, string> Select(string statement)
    {
        var sql = statement.TrimEnd().TrimEnd(';');
        ReadContext? context = store.OpenSqlDoorRead(cancel);
        try
        {
            if (SqlDoor.RefusalOf(context, sql, TableDdlBuilder.IndexedSchema) is { } refusal) return refusal;
            context.Execute($"SET search_path = '{TableDdlBuilder.IndexedSchema}'");
            var rows = context.Streamed(sql);
            context = null;
            return rows;
        }
        finally
        {
            context?.Dispose();
        }
    }

    /// <summary>Row count per record type for one plugin, narrowed by the filter as Search is
    /// (SetFilter never affects a point read).</summary>
    public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginAddress plugin)
    {
        using var context = OpenRead();
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
        using var context = OpenRead();
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
        using var context = OpenRead();
        return LinkResolution.Resolve(context, formKey);
    }

    public LinkResolver NewLinkResolver() => new(Resolve);

    private void LearnLinks(LinkResolver resolver, ReadContext context, IEnumerable<(string Body, string RecordType)> documents) =>
        resolver.Learn(context, documents.SelectMany(document =>
            FormReferences.Collect(document.Body, store.Schemas[document.RecordType].RecordColumns).Select(reference => reference.TargetFormKey)));

    // A join of winners would hold the whole index in memory.
    public IReadOnlyDictionary<string, string> RecordTypesOf(List<string> formKeys)
    {
        using var context = OpenRead();
        return context.Rows($"""
            SELECT r.form_key, r.record_type
            FROM {Copies}
            WHERE r.form_key IN (SELECT unnest($1::VARCHAR[])) AND {ActiveOrCompiled}
            QUALIFY row_number() OVER (PARTITION BY r.form_key ORDER BY p.load_order_idx DESC NULLS LAST, r.plugin, r.origin) = 1
            """, reader => KeyValuePair.Create(reader.GetString(0), reader.GetString(1)), formKeys)
            .ToDictionary(StringComparer.OrdinalIgnoreCase);
    }

    private List<MissingReference> GetReferencesToMissingRecords(PluginAddress? only, IReadOnlySet<string>? forms)
    {
        using var context = OpenRead();
        var release = store.Release;
        var narrowed = new List<object>();
        var narrowing = "";
        if (only is { } plugin)
        {
            narrowed.AddRange([plugin.Name, plugin.Origin]);
            narrowing += $" AND fr.source_plugin = ${narrowed.Count - 1} AND fr.source_origin = ${narrowed.Count}";
        }
        if (forms is not null)
        {
            narrowed.Add(forms.ToList());
            narrowing += $" AND fr.source_form_key IN (SELECT unnest(${narrowed.Count}::VARCHAR[]))";
        }
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
              {narrowing}
            ORDER BY fr.source_plugin, fr.source_origin, fr.source_form_key, fr.field_path
            """, reader => new MissingReference(
                reader.GetPluginAddress(), reader.GetString(2), reader.GetString(3),
                reader.GetStringOrNull(4), reader.GetString(5), reader.GetString(6)), [.. narrowed])
            .Where(reference => FormKeyResolution.From(reference.TargetFormKey, null, [], release).State == FormKeyResolutionState.Unresolved)
            .ToList();
    }

    /// <summary>Each link from a plugin read from its source tree to a FormKey no active plugin holds
    /// and the engine does not define, on its file in <paramref name="sourceOf"/>.</summary>
    public IReadOnlyList<MissingReferenceOnFile> GetReferencesToMissingRecordsOnFiles(
        PluginAddress? only, IReadOnlySet<string>? forms, Func<PluginAddress, ISourceRepositoryReads?> sourceOf)
    {
        var repositories = new Dictionary<PluginAddress, ISourceRepositoryReads?>(PluginAddress.Comparer);
        return
        [
            .. GetReferencesToMissingRecords(only, forms).Select(reference =>
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

    /// <summary>The plugin files each plugin read from its source tree links into: a FormKey names its origin plugin.</summary>
    public ILookup<PluginAddress, string> GetPluginsLinkedBySourcePlugins()
    {
        using var context = OpenRead();
        return context.Rows($"""
            SELECT DISTINCT fr.source_plugin, fr.source_origin, substr(fr.target_form_key, {FormKeyPluginStart})
            FROM {TableDdlBuilder.MirrorSchema}.form_references fr
            {TableDdlBuilder.RegisteredJoin("fr", "source_plugin", "source_origin")}
            JOIN {TableDdlBuilder.MirrorSchema}.{TableDdlBuilder.PluginDerivationTable} d
              ON d.plugin = fr.source_plugin AND d.origin = fr.source_origin AND d.derived_from = '{DerivedFrom.SourceTree}'
            """, reader => (Plugin: reader.GetPluginAddress(), Linked: reader.GetString(2)))
            .ToLookup(row => row.Plugin, row => row.Linked, PluginAddress.Comparer);
    }

    private static readonly string ActiveOrCompiledPluginReferrers = $"""
        {TableDdlBuilder.MirrorSchema}.form_references fr
        {TableDdlBuilder.RegisteredJoin("fr", "source_plugin", "source_origin")}
        JOIN {TableDdlBuilder.MirrorSchema}.{TableDdlBuilder.PluginDerivationTable} d
          ON d.plugin = fr.source_plugin AND d.origin = fr.source_origin
        """;

    private static readonly string Copies = $"""
        {TableDdlBuilder.MirrorSchema}.records r
        {TableDdlBuilder.RegisteredJoin("r", "plugin", "origin")}
        JOIN {TableDdlBuilder.MirrorSchema}.{TableDdlBuilder.PluginDerivationTable} d
          ON d.plugin = r.plugin AND d.origin = r.origin
        """;

    private static readonly string ActiveOrCompiled = $"(p.load_order_idx IS NOT NULL OR d.derived_from <> '{DerivedFrom.Binary}')";

    private static readonly string InPluginSource = $"d.derived_from <> '{DerivedFrom.Binary}'";

    private static (CopyNaming Copy, RecordIdentity Identity) CopyNamingOf(System.Data.Common.DbDataReader reader) =>
        (new CopyNaming(reader.GetString(0), new PluginAddress(reader.GetString(1), reader.GetString(2)), reader.GetBoolean(3)),
            new RecordIdentity(reader.GetString(0), reader.GetString(4), reader.GetStringOrNull(5)));

    /// <summary>Each copy that references the record, in an active plugin or a compiled one (ADR-0012).</summary>
    public IReadOnlyList<ReferenceRow> GetReferencedByInActiveOrCompiledPlugins(string targetFormKey)
    {
        using var context = OpenRead();
        // WorkingTreeOverlay keeps form_references rewritten as the working tree changes, so this
        // already sees every edit without applying anything itself.
        return context.Rows($"""
            SELECT fr.source_form_key, fr.source_plugin, fr.field_path, fr.record_type, fr.editor_id, fr.source_origin
            FROM {ActiveOrCompiledPluginReferrers}
            WHERE fr.target_form_key = $1 AND {ActiveOrCompiled}
            """, reader => new ReferenceRow(
                reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
                reader.GetStringOrNull(4), reader.GetString(5)),
            targetFormKey);
    }

    // SQL's 1-based position of a FormKey's plugin name, after its six-digit object ID and its colon.
    private const int FormKeyPluginStart = 8;

    /// <summary>Each copy naming the plugin file <paramref name="name"/> in an active or compiled plugin, by its own
    /// FormKey or a link, and the Plugin Header of each such plugin read from its binary that lists it.</summary>
    public IReadOnlyList<(CopyNaming Copy, RecordIdentity Identity)> GetCopiesNaming(string name)
    {
        using var context = OpenRead();
        // A record's masters leave out its own plugin, so an override that links its plugin's records is found by its links.
        var copies = context.Rows($"""
            SELECT r.form_key, r.plugin, r.origin, {InPluginSource}, r.record_type, r.editor_id
            FROM {Copies}
            WHERE (r.form_key_plugin = $1 OR list_contains(list_transform(r.masters, m -> lower(m)), lower($1)))
              AND {ActiveOrCompiled}
            UNION ALL
            SELECT DISTINCT fr.source_form_key, fr.source_plugin, fr.source_origin, {InPluginSource}, fr.record_type, fr.editor_id
            FROM {ActiveOrCompiledPluginReferrers}
            WHERE fr.source_plugin = $1 AND lower(substr(fr.target_form_key, {FormKeyPluginStart})) = lower($1)
              AND lower(substr(fr.source_form_key, {FormKeyPluginStart})) <> lower($1) AND {ActiveOrCompiled}
            ORDER BY 2, 3, 1
            """, CopyNamingOf, name);
        var headers = context.Rows($"""
            SELECT d.plugin, d.origin, {InPluginSource}
            FROM {TableDdlBuilder.MirrorSchema}.{TableDdlBuilder.PluginDerivationTable} d
            {TableDdlBuilder.RegisteredJoin("d", "plugin", "origin")}
            WHERE d.derived_from <> '{DerivedFrom.SourceTree}'
              AND {ActiveOrCompiled}
            ORDER BY d.plugin, d.origin
            """, reader => (Plugin: reader.GetPluginAddress(), InPluginSource: reader.GetBoolean(2)))
            .Where(header => OpenedPlugins.GetValueOrDefault(header.Plugin)?.Masters.Contains(name, StringComparer.OrdinalIgnoreCase) == true)
            .Select(header => HeaderNaming(header.Plugin, header.InPluginSource));
        return [.. headers.Concat(copies).DistinctBy(found => (found.Copy.FormKey, found.Copy.Plugin.Name, found.Copy.Plugin.Origin))];
    }

    private static (CopyNaming Copy, RecordIdentity Identity) HeaderNaming(PluginAddress plugin, bool inPluginSource)
    {
        var formKey = PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name));
        return (new CopyNaming(formKey, plugin, inPluginSource), new RecordIdentity(formKey, PluginHeader.RecordType, null));
    }

    /// <summary>Each copy of the record <paramref name="formKey"/> names in an active plugin with no plugin source, and
    /// each copy there that links it.</summary>
    public IReadOnlyList<RecordAt> GetCopiesWithNoPluginSourceNaming(string formKey)
    {
        using var context = OpenRead();
        var activeWithNoPluginSource = $"p.load_order_idx IS NOT NULL AND NOT {InPluginSource}";
        return [.. context.Rows($"""
            SELECT r.form_key, r.plugin, r.origin
            FROM {Copies}
            WHERE r.form_key = $1 AND {activeWithNoPluginSource}
            UNION
            SELECT fr.source_form_key, fr.source_plugin, fr.source_origin
            FROM {ActiveOrCompiledPluginReferrers}
            WHERE fr.target_form_key = $1 AND {activeWithNoPluginSource}
            ORDER BY 2, 3, 1
            """, reader => new RecordAt(new PluginAddress(reader.GetString(1), reader.GetString(2)), reader.GetString(0)), formKey)];
    }

    /// <summary>What the documents of <paramref name="plugin"/> (every registered plugin when null) name, in their records'
    /// order, narrowed to <paramref name="formKeys"/> when given.</summary>
    public IReadOnlyList<NamedAt> GetDocumentNames(PluginAddress? plugin, IReadOnlyCollection<string>? formKeys)
    {
        List<object> values = [];
        var narrowing = "TRUE";
        if (plugin is { } only)
        {
            values.AddRange([only.Name, only.Origin]);
            narrowing += " AND n.plugin = $1 AND n.origin = $2";
        }
        if (formKeys is not null)
        {
            values.Add(formKeys.ToList());
            narrowing += $" AND n.form_key IN (SELECT unnest(${values.Count}::VARCHAR[]))";
        }
        return DocumentNamesWhere(narrowing, [.. values]);
    }

    /// <summary>Each attachment of the script <paramref name="name"/> in an active plugin or a compiled one.</summary>
    public IReadOnlyList<NamedAt> GetScriptAttachments(string name) =>
        DocumentNamesWhere($"n.kind = '{DocumentNameKind.Script}' AND n.name = $1 AND {ActiveOrCompiled}", name);

    /// <summary>Each member of an active or compiled plugin that names the file <paramref name="dataPath"/>, and each path
    /// naming <paramref name="fileName"/> that no file can be named for.</summary>
    public IReadOnlyList<NamedAt> GetFileNamings(string dataPath, string fileName) =>
        DocumentNamesWhere(
            $"n.kind = '{DocumentNameKind.File}' AND (CASE WHEN n.refusal IS NULL THEN n.name = $1 ELSE contains(lower(n.name), lower($2)) END) AND {ActiveOrCompiled}", dataPath, fileName);

    private List<NamedAt> DocumentNamesWhere(string filter, params object[] values)
    {
        using var context = OpenRead();
        return context.Rows($"""
            SELECT n.plugin, n.origin, n.form_key, n.record_type, n.editor_id, n.kind, n.field_path, n.name, n.refusal, {InPluginSource}
            FROM {TableDdlBuilder.MirrorSchema}.document_names n
            {TableDdlBuilder.RegisteredJoin("n", "plugin", "origin")}
            JOIN {TableDdlBuilder.MirrorSchema}.{TableDdlBuilder.PluginDerivationTable} d
              ON d.plugin = n.plugin AND d.origin = n.origin
            WHERE {filter}
            ORDER BY n.plugin, n.origin, n.form_key, n.rowid
            """, reader => new NamedAt(
                reader.GetPluginAddress(), reader.GetBoolean(9),
                new DocumentNameRow(
                    reader.GetString(2), reader.GetString(3), reader.GetStringOrNull(4), Enum.Parse<DocumentNameKind>(reader.GetString(5)),
                    reader.GetString(6), reader.GetStringOrNull(7), reader.GetStringOrNull(8))),
            values);
    }

    /// <summary>Each of <paramref name="copies"/> a registered plugin holds, read in batches as the caller takes them.</summary>
    public IEnumerable<CopyHoldingText> GetCopies(IReadOnlyList<RecordAt> copies) => copies.Count == 0 ? [] : CopiesOf(copies);

    private IEnumerable<CopyHoldingText> CopiesOf(IReadOnlyList<RecordAt> copies)
    {
        using var context = OpenRead();
        var asked = copies.ToHashSet(RecordAt.Comparer);
        List<(CopySize Copy, bool InPluginSource)> located = [.. context.Rows($"""
            SELECT r.form_key, r.plugin, r.origin, r.document_length, r.copy_id, {InPluginSource}
            FROM (SELECT form_key, plugin, origin, document_length, copy_id
                  FROM {TableDdlBuilder.MirrorSchema}.records WHERE form_key IN (SELECT unnest($1::VARCHAR[]))) r
            {TableDdlBuilder.RegisteredJoin("r", "plugin", "origin")}
            JOIN {TableDdlBuilder.MirrorSchema}.{TableDdlBuilder.PluginDerivationTable} d
              ON d.plugin = r.plugin AND d.origin = r.origin
            ORDER BY r.plugin, r.origin, r.form_key
            """, reader => (Copy: CopySizeOf(reader), InPluginSource: reader.GetBoolean(5)),
            copies.Select(copy => copy.FormKey).Distinct(StringComparer.OrdinalIgnoreCase).ToList())
            .Where(found => asked.Contains(new RecordAt(found.Copy.Plugin, found.Copy.FormKey)))];
        foreach (var (found, stored) in located.Zip(Stored(context, located.Select(found => new[] { found.Copy }))))
            yield return new CopyHoldingText(found.Copy.FormKey, found.Copy.Plugin, stored[0].RecordType, stored[0].EditorId, stored[0].Body, found.InPluginSource);
    }

    /// <summary>Every plugin at least one filtered record matches, restricted to
    /// <paramref name="tableNames"/> (plugins.md). Empty when no filter is active: every plugin
    /// already has matches.</summary>
    public IReadOnlySet<PluginAddress> GetPluginsWithMatchingRecords(
        IEnumerable<string> tableNames, IReadOnlyCollection<PluginAddress>? among = null)
    {
        var types = tableNames.ToList();
        if (types.Count == 0 || !store.Filter.Active || among is { Count: 0 })
            return new HashSet<PluginAddress>(PluginAddress.Comparer);

        using var context = OpenRead();

        var (where, paramValues) = BuildWhere(
            null, null, FilterMatches.Matching, origin: null, recordTypes: types);
        if (among is not null)
        {
            var pairs = among.Select((plugin, i) => $"(${paramValues.Count + 2 * i + 1}, ${paramValues.Count + 2 * i + 2})");
            where += $" AND (plugin, origin) IN ({string.Join(", ", pairs)})";
            paramValues.AddRange(among.SelectMany(plugin => new[] { plugin.Name, plugin.Origin }));
        }

        return new HashSet<PluginAddress>(
            context.Rows($"SELECT DISTINCT plugin, origin FROM records{where}",
                reader => reader.GetPluginAddress(), [.. paramValues]),
            PluginAddress.Comparer);
    }

    /// <summary>Every Kind B diagnosis the registered plugins' binaries prove, projected when each
    /// binary was hashed and gone with its rows: the malformed-plugin read.</summary>
    public IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses()
    {
        using var context = OpenRead();
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
        using var context = OpenRead();
        var rows = context.Rows($"SELECT plugin, origin, strings_read FROM {Store.Store.FilesRelation} WHERE strings_read IS NOT NULL",
            reader => KeyValuePair.Create(reader.GetPluginAddress(), reader.GetString(2)));
        return new Dictionary<PluginAddress, string>(rows, PluginAddress.Comparer);
    }

    /// <summary>The strings language each plugin's names were derived in.</summary>
    public IReadOnlyDictionary<PluginAddress, string> GetNamesLanguages()
    {
        using var context = OpenRead();
        var rows = context.Rows($"SELECT plugin, origin, names_language FROM {TableDdlBuilder.PluginDerivationTable}",
            reader => KeyValuePair.Create(reader.GetPluginAddress(), reader.GetString(2)));
        return new Dictionary<PluginAddress, string>(rows, PluginAddress.Comparer);
    }

    /// <summary>What each registered plugin's rows were derived from. A plugin with no rows is absent.</summary>
    public IReadOnlyDictionary<PluginAddress, DerivedFrom> GetDerivations()
    {
        using var context = OpenRead();
        var rows = context.Rows($"SELECT plugin, origin, derived_from FROM {TableDdlBuilder.PluginDerivationTable}",
            reader => KeyValuePair.Create(
                reader.GetPluginAddress(), Enum.Parse<DerivedFrom>(reader.GetString(2))));
        return new Dictionary<PluginAddress, DerivedFrom>(rows, PluginAddress.Comparer);
    }

    /// <summary>Every plugin holding a record whose document failed or a record type whose
    /// enumeration did: the tree's "has a failure below it" for a plugin row.</summary>
    public IReadOnlySet<PluginAddress> GetPluginsWithParseFailures()
    {
        using var context = OpenRead();
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
        using var context = OpenRead();
        return context.Rows($"""
            WITH RECURSIVE {NavigatorSql.AboveAFailure(RecordScope.Active, "WHERE h.plugin = $1 AND h.origin = $2")}
            SELECT cl.cell_form_key, c.editor_id, cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y,
                   c.full_name, c.parse_diagnosis,
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
        using var context = OpenRead();
        var parents = context.Rows($"""
            SELECT DISTINCT h.parent FROM holdings h
            JOIN cell_location cl ON cl.cell_form_key = h.child AND cl.plugin = h.plugin AND cl.origin = h.origin
            WHERE h.plugin = $1 AND h.origin = $2{store.Filter.AlsoKeeps("cl", "cell_form_key")}
            """, reader => reader.GetString(0), plugin.Name, plugin.Origin);
        return new HashSet<string>(parents, StringComparer.OrdinalIgnoreCase);
    }

    public CellChildRecords GetCellChildRecords(PluginAddress plugin, string cellFormKey)
    {
        using var context = OpenRead();
        var children = context.Rows($"""
            WITH {NavigatorSql.HeldFor(RecordScope.Active, "WHERE h.plugin = $2 AND h.origin = $3")},
            children AS (
                SELECT p.placement_group, r.record_type, p.form_key, r.editor_id, r.base,
                       r.parse_diagnosis, r.full_name, r.working_tree_state, r.form_key_plugin
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
        using var context = OpenRead();
        return GetCellLocation(context, cellFormKey, plugin.Name, plugin.Origin);
    }

    /// <summary>Everything <paramref name="parentFormKey"/> holds, placed references and cells
    /// included, in FormID order; empty when it holds nothing. Ref-invariant by construction.</summary>
    public IReadOnlyList<HoldingRow> GetHoldings(PluginAddress plugin, string parentFormKey)
    {
        using var context = OpenRead();
        return GetHoldings(
            context, plugin.Name, plugin.Origin, parentFormKey, store.Filter.AlsoKeeps("cc", "child"), NavigatorSql.FormIdOrder("r.form_key_plugin", "cc.child"));
    }

    /// <summary>Every child <paramref name="parentFormKey"/> holds, whatever filter is in force, by slot and
    /// place in it.</summary>
    public IReadOnlyList<HoldingRow> GetEveryHolding(PluginAddress plugin, string parentFormKey)
    {
        using var context = OpenRead();
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

    // The callers hold ADR-0012, not this builder: every caller passes a plugin's name and origin
    // both or neither.
    private static (string where, List<string> paramValues) BuildWhere(
        string? plugin, string? search, string? filterCondition = null, string? origin = null,
        IReadOnlyList<string>? recordTypes = null, string? searchFormKey = null, IReadOnlyList<string>? formKeys = null)
    {
        var conditions = new List<string>();
        var values = new List<string>();

        if (recordTypes is { Count: > 0 })
        {
            var placeholders = recordTypes.Select((_, i) => $"${values.Count + i + 1}");
            conditions.Add($"record_type IN ({string.Join(", ", placeholders)})");
            values.AddRange(recordTypes.Select(NormalizeRecordType));
        }

        if (formKeys != null)
        {
            var placeholders = formKeys.Select((_, i) => $"${values.Count + i + 1}");
            conditions.Add($"form_key IN ({string.Join(", ", placeholders)})");
            values.AddRange(formKeys);
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
            LEFT JOIN {TableDdlBuilder.MirrorSchema}.records r ON r.form_key = cc.child AND r.plugin = $2 AND r.origin = $3
            WHERE cc.parent = $1 AND cc.plugin = $2 AND cc.origin = $3{inFilter}
            ORDER BY {order}
            """, reader => new HoldingRow(parentFormKey, reader.GetString(0), reader.GetString(1), reader.GetInt32(2)),
            parentFormKey, plugin, origin);
    }

    private RecordDocument ReadDocumentFromBody(ReadContext context, StoredCopy copy, Func<string, RecordLookupEntry?> resolveFormKey) =>
        DocumentFromBody(
            context, copy.FormKey, copy.Plugin.Name, copy.Plugin.Origin, copy.LoadOrderIndex ?? int.MaxValue, copy.IsWinner, copy.EditorId,
            copy.Body, store.Schemas[copy.RecordType], resolveFormKey, copy.ParseDiagnosis);

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
