using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Store;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Queries;

/// <summary>The face over the Indexer: a read the Indexer cannot answer for want of a load order or
/// the whole set is the refusal it answers.</summary>
internal sealed class RecordQueries(
    Indexer index,
    FilterInForce filter,
    LoadOrderHolder loadOrder,
    SchemaReflector schemaReflector,
    ISourceAdapter source,
    ILogger<RecordQueries> logger) : IQueries, IDisposable
{
    private readonly ILogger _logger = logger;
    private readonly Indexer _index = index;
    private readonly IndexAnswer _answer = new(index.RecoverFromInvalidation);
    private readonly LoadOrderHolder _loadOrder = loadOrder;
    private readonly SchemaReflector _schemaReflector = schemaReflector;
    private const int NotInLoadOrder = int.MaxValue;

    private readonly ConflictClassifier _conflictClassifier = new ConflictClassifier(logger);

    public Answer<IReadOnlyList<PluginResponse>, IndexRefused> GetPlugins() => _answer.Of(PluginResponses);

    private IReadOnlyList<PluginResponse> PluginResponses()
    {
        var reads = RequireReads();
        var opened = reads.OpenedPlugins;
        // The rows and their order are the load order's; the facts reading the file yielded are the
        // Index's. A plugin the Index has not opened has none of the latter and is not a row.
        var snapshot = _loadOrder.Require();
        var rows = snapshot.Plugins.Where(c => opened.ContainsKey(c.Key)).ToList();
        var masterIssues = Indexed
            ? MasterResolution.Classify(snapshot, opened)
            : null;
        var parseFailures = reads.GetPluginsWithParseFailures();
        var derivations = reads.GetDerivations();
        PluginResponse ToResponse(RegisteredPlugin plugin, bool hasMatchingRecords)
        {
            DerivedFrom? derivedFrom = derivations.TryGetValue(plugin.Key, out var stamped) ? stamped : null;
            var problems = masterIssues?.GetValueOrDefault(plugin.Key, MasterProblems.None);
            var content = opened[plugin.Key];
            var loadOrderIndex = snapshot.LoadOrderIndex(plugin.Key);
            return new(plugin.Name, plugin.Path, loadOrderIndex, content.IsLight, content.IsMaster, content.IsBlueprint,
                content.Masters, IsImmutable: snapshot.ProviderOf(plugin.Key) == PluginProvider.Game, plugin.Origin,
                problems?.Missing, problems?.Late, InLoadOrder: loadOrderIndex is not null, hasMatchingRecords,
                IsCompiledPlugin: derivedFrom?.IsSourceMod() ?? false,
                HasParseFailure: parseFailures.Contains(plugin.Key),
                PluginSourceUnreadable: derivedFrom == DerivedFrom.BinaryForUnreadableSource ? WhyUnreadable(plugin) : null,
                _index.LaterReadFailure(plugin.Key)?.Select(SourceProblem.StoppedAt).ToList());
        }

        if (filter.Current is null)
            return [.. rows.Select(c => ToResponse(c, hasMatchingRecords: true))];

        // plugins.md: a record filter prunes records and record types, never
        // a plugin row — every plugin is still returned, and HasMatchingRecords is the additive fact
        // a caller decides expandability from, not row presence.
        var matchingPlugins = reads.GetPluginsWithMatchingRecords(RequireSchemas().Keys);
        return [.. rows.Select(c => ToResponse(c, matchingPlugins.Contains(c.Key)))];
    }

    private UnreadableSource WhyUnreadable(RegisteredPlugin plugin) =>
        source.WhySourceDoesNotRead(plugin) is { } failure ? UnreadableSources.Of(failure)
        : _index.WhyTreeStopped(plugin.Key) ?? UnreadableSources.Unknown;

    // The header is not a browsable record type: it stays a schemas.Keys entry so GetRecord/
    // GetCompare resolve it by FormKey, but both browse paths below exclude it.
    private static bool IsGroup(string recordType, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        recordType != PluginHeader.RecordType && schemas.ContainsKey(recordType);

    public Answer<PagedResult<RecordSummary>, IndexRefused> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset) =>
        _answer.Of(() => RecordPage(types, plugin, search, limit, offset));

    private PagedResult<RecordSummary> RecordPage(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset)
    {
        var reads = RequireReads();
        var schemas = RequireSchemas();

        IReadOnlyList<string> recordTypes = types is null
            ? [.. schemas.Keys.Where(t => IsGroup(t, schemas))]
            : [.. types.Where(schemas.ContainsKey)];
        if (recordTypes.Count == 0)
            return new PagedResult<RecordSummary>([], 0);
        PluginName? pluginFilter = null;
        if (plugin is { } address) pluginFilter = address.Name;
        var scope = search is null ? RecordQueryScope.Navigator : RecordQueryScope.Search;
        var query = new RecordQuery(
            scope, RecordTypes: recordTypes, Plugin: pluginFilter, Origin: plugin?.Origin, Search: search,
            SearchFormKey: FormKeyOfFormId(search, reads), Limit: limit, Offset: offset,
            GroupOnly: scope == RecordQueryScope.Navigator);
        return reads.Search(query);
    }

    private string? FormKeyOfFormId(string? search, RelationReads reads) =>
        search is null ? null : LoadIndex.FormKeyOf(search, _loadOrder.Require(), reads.OpenedPlugins)?.ToString();

    public Answer<RecordDetail?, IndexRefused> GetRecord(string formKey) => _answer.Of(() =>
    {
        var document = _index.RequireWholeSetReads().GetDocument(formKey);
        return document == null ? null : ToRecordDetail(document);
    });

    public Answer<CompareResult?, IndexRefused> GetCompare(string formKey, CopyText? text = null) =>
        _answer.Of(() => CompareOf(formKey, text));

    private CompareResult? CompareOf(string formKey, CopyText? text)
    {
        var reads = RequireReads();
        var stack = text?.Alone == true ? null : reads.GetOverrideStack(formKey);
        if (stack == null && text == null) return null;
        var snapshot = _loadOrder.Require();

        var active = stack?.Entries.Select(e => e.Effective).ToList() ?? [];
        var outside = new List<RecordDocument>();
        if (text is not null)
        {
            var at = active.FindIndex(c => PluginAddress.Comparer.Equals(c.Plugin, text.Plugin));
            var loadOrderIndex = at >= 0 ? active[at].LoadOrderIndex : snapshot.LoadOrderIndex(text.Plugin) ?? NotInLoadOrder;
            var fromText = CopyFromText(reads, formKey, text.Plugin, loadOrderIndex, text.DocumentText);
            if (fromText is null) return null;
            if (at >= 0) active[at] = fromText with { IsWinner = active[at].IsWinner };
            else outside.Add(fromText);
        }
        var recordType = (active.Count > 0 ? active[0] : outside[0]).RecordType;

        // One memoizing cache per response (ADR-0005): a FormKey repeated across sibling
        // cells/plugins/leaves (generic fields and VMAD alike) is resolved at most once.
        var resolveFormKey = reads.LinkResolver(formKey);
        var formIds = LoadIndex.FormIdsOf(snapshot, reads.OpenedPlugins);
        var overrides = active.ConvertAll(ToRecordDetail);
        var outsideTheComparison = outside.ConvertAll(ToRecordDetail);
        var (classification, conflictAll) = ClassifyStack(overrides, resolveFormKey, formIds, outsideTheComparison);
        // PluginStates is keyed by ColumnKey.Of (ADR-0012), so a bare-plugin lookup
        // would miss for any non-Data-origin column and silently drop its ConflictThis.
        var annotated = overrides.Concat(outsideTheComparison)
            .Select(o => ToCompareOverride(
                o, classification.PluginStates.TryGetValue(ColumnKey.Of(o.Plugin, o.Origin), out var state) ? state : null,
                column: null, snapshot, reads))
            .ToList();
        if (outsideTheComparison.Count == 1) PlaceBeforeOverrider(annotated, snapshot);

        return ComparisonOf(annotated, classification.Diffs, conflictAll, recordType, snapshot);
    }

    private CompareResult ComparisonOf(
        IReadOnlyList<CompareOverride> overrides, IReadOnlyList<FieldDiff> diffs, ConflictAll conflictAll, string recordType,
        LoadOrderSnapshot snapshot) =>
        new(overrides, diffs, conflictAll, RequireSchemas().DisplayNameFor(recordType), snapshot.StringsLanguage.ToString());

    // The outside copy is last. When its plugin is overridden, it moves to just before the place of the
    // active plugin of its filename.
    private static void PlaceBeforeOverrider(List<CompareOverride> columns, LoadOrderSnapshot snapshot)
    {
        var overridden = columns[^1];
        var overrider = snapshot.Active.FirstOrDefault(p => string.Equals(p.Name, overridden.Plugin, StringComparison.OrdinalIgnoreCase));
        if (overrider is null) return;
        var overriderIndex = snapshot.Active.ToList().IndexOf(overrider);
        var at = columns.Count - 1;
        var before = columns.Take(at).Count(c => c.LoadOrderIndex < overriderIndex);
        columns.RemoveAt(at);
        columns.Insert(before, overridden);
    }

    private static CopyMissing CopyMissingFor(RelationReads reads, RecordCopy copy) =>
        reads.IsHeldByAnyPlugin(copy.FormKey)
            ? new CopyMissing(copy.FormKey, copy.Plugin, CopyMissingReason.NotInPlugin, $"{copy.FormKey} is not in {copy.Plugin.Name} ({copy.Plugin.Origin}).")
            : new CopyMissing(copy.FormKey, copy.Plugin, CopyMissingReason.RecordGone, $"{copy.FormKey} is held by no plugin.");

    public Answer<CompareRecordsAnswer, IndexRefused> GetCompareRecords(IReadOnlyList<RecordCopy> copies) =>
        _answer.Of(() => CompareCopies(copies));

    private CompareRecordsAnswer CompareCopies(IReadOnlyList<RecordCopy> copies)
    {
        var reads = _index.RequireWholeSetReads();
        var snapshot = _loadOrder.Require();

        var documents = new List<RecordDocument>(copies.Count);
        var missing = new List<RecordCopy>();
        foreach (var copy in copies)
        {
            var document = copy.DocumentText is { } text
                ? CopyFromText(reads, copy.FormKey, copy.Plugin, snapshot.LoadOrderIndex(copy.Plugin) ?? NotInLoadOrder, text)
                : reads.GetDocument(copy.FormKey, copy.Plugin);
            if (document == null) missing.Add(copy);
            else documents.Add(document);
        }
        if (missing.Count > 0)
            return CompareRecordsAnswer.CopiesMissing([.. missing.Select(c => CopyMissingFor(reads, c))]);

        var records = documents.ConvertAll(ToRecordDetail);
        // Two copies may come from one plugin, so a column is named by its place as well.
        var columns = records.Select((r, i) => $"{i}#{ColumnKey.Of(r.Plugin, r.Origin)}").ToList();
        var diffs = _conflictClassifier.Align(
            records, columns, snapshot.GameRelease, reads.LinkResolver(copies[0].FormKey), LoadIndex.FormIdsOf(snapshot, reads.OpenedPlugins),
            indexed: true);
        var overrides = records.Select((r, i) => ToCompareOverride(r, state: null, columns[i], snapshot, reads)).ToList();

        var conflictAll = ConflictRules.Worst(ConflictAll.NoConflict, diffs.Select(diff => diff.ConflictAll));
        return CompareRecordsAnswer.Compared(
            ComparisonOf(overrides, diffs, conflictAll, documents[0].RecordType, snapshot));
    }

    // The text is the document carrying the record. A plugin's source tree says which document that is, as it
    // does for an edit; a plugin with no tree has only the record's own.
    private RecordDocument? CopyFromText(
        RelationReads reads, string formKey, PluginAddress plugin, int loadOrderIndex, string text)
    {
        if (TreeOf(plugin) is not { } tree)
            return reads.DocumentFromText(formKey, plugin, loadOrderIndex, text);

        if (!tree.RecordFromText(plugin, formKey, text).Holds(out var record, out var refused))
        {
            _logger.LogWarning("{FormKey} in {Plugin} cannot be read from its source tree: {Cause}", formKey, plugin.Name, refused.Reason);
            return Unread(reads, formKey, plugin, loadOrderIndex, refused.Reason);
        }
        return record is not null
            ? reads.DocumentFromText(formKey, plugin, loadOrderIndex, record.Body)
            : Unread(reads, formKey, plugin, loadOrderIndex, $"No document in {plugin.Name}'s source tree carries {formKey}.");
    }

    private static RecordDocument? Unread(RelationReads reads, string formKey, PluginAddress plugin, int loadOrderIndex, string why) =>
        reads.DocumentFromText(formKey, plugin, loadOrderIndex, CallerText.NoBody) is { } unread ? unread with { ParseDiagnosis = why } : null;

    private static CompareOverride ToCompareOverride(
        RecordDetail o, ConflictThis? state, string? column, LoadOrderSnapshot snapshot, RelationReads reads) =>
        new(o.FormKey, o.Plugin, o.LoadOrderIndex, o.IsWinner, o.EditorId, o.Fields, state,
            Origin: o.Origin,
            LoadIndex: LoadIndex.Of(new PluginAddress(o.Plugin, o.Origin), o.LoadOrderIndex, snapshot, reads.OpenedPlugins),
            RecordType: o.RecordType, IsPartialForm: o.IsPartialForm, ParseDiagnosis: o.ParseDiagnosis,
            IsInOverwrite: snapshot.ProviderOf(new PluginAddress(o.Plugin, o.Origin)) == PluginProvider.NoMod,
            Column: column, MissingStringsFile: o.MissingStringsFile, Templated: o.Templated);

    private (ClassifyResult Classification, ConflictAll ConflictAll) ClassifyStack(
        List<RecordDetail> committedOverrides,
        Func<string, RecordLookupEntry?> resolveFormKey,
        Func<string, uint?> loadOrderFormIds,
        List<RecordDetail> outsideTheComparison)
    {
        var release = _loadOrder.Require().GameRelease;
        // With no active copy there is nothing to compare: the copy outside it stands alone.
        var classification = committedOverrides.Count > 0
            ? _conflictClassifier.Classify(
                committedOverrides, release, resolveFormKey, loadOrderFormIds, Indexed, outsideTheComparison)
            : new ClassifyResult(
                ConflictAll.NoConflict, new Dictionary<string, ConflictThis>(),
                _conflictClassifier.Align(
                    outsideTheComparison, [.. (outsideTheComparison).Select(r => ColumnKey.Of(r.Plugin, r.Origin))],
                    release, resolveFormKey, loadOrderFormIds, Indexed));
        return (classification, classification.ConflictAll);
    }

    public Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused> GetPluginRecordTypes(PluginAddress plugin) =>
        _answer.Of(() => RecordTypeCounts(plugin));

    private IReadOnlyList<PluginRecordTypeCount> RecordTypeCounts(PluginAddress plugin)
    {
        var reads = RequireReads();
        var schemas = RequireSchemas();
        var types = RecordTypes.For(_loadOrder.Require().GameRelease);

        return [.. reads.GetRecordTypeCounts(plugin)
            .Where(c => IsGroup(c.Type, schemas))
            .Select(c => new PluginRecordTypeCount(
                c.Type, c.Count, schemas.DisplayNameFor(c.Type), c.HasParseFailure,
                types.IsCreatable(c.Type), types.HasChildSlots(c.Type)))
            .OrderBy(r => r.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.Type, StringComparer.Ordinal)];
    }

    public Answer<WorkingTreeStatesBeneath, IndexRefused> GetWorkingTreeStatesBeneath(PluginAddress plugin) =>
        _answer.Of(() => RequireReads().GetWorkingTreeStatesBeneath(plugin));

    public Answer<IReadOnlyList<RecordTypeChoice>, IndexRefused> GetCreatableRecordTypes() => _answer.Of<IReadOnlyList<RecordTypeChoice>>(() =>
    {
        var schemas = RequireSchemas();
        return Choices(RecordTypes.For(_loadOrder.Require().GameRelease).Creatable, schemas);
    });

    public Answer<IReadOnlyList<string>, IndexRefused> GetCreatablePluginExtensions() =>
        _answer.Of(() => CreatablePluginExtensions.Of(_loadOrder.Require().GameRelease));

    public Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused> GetChildRecordTypes(PluginAddress plugin, string formKey) =>
        _answer.Of<IReadOnlyList<RecordTypeChoice>?>(() => ChildRecordTypesOf(plugin, formKey));

    private List<RecordTypeChoice>? ChildRecordTypesOf(PluginAddress plugin, string formKey)
    {
        var reads = RequireReads();
        if (reads.GetDocument(formKey, plugin) is not { Body: { } body } container) return null;
        var schemas = RequireSchemas();
        var place = reads.GetCellLocation(plugin, formKey)?.Place;
        var held = reads.GetEveryHolding(plugin, formKey).Select(holding => (holding.Slot, holding.Child));
        return Choices(ChildRecordTypes.Of(container.RecordType, body, held, place, _loadOrder.Require().GameRelease), schemas);
    }

    // Sorted as a plugin's groups are, so the pick reads in the order the tree shows.
    private static List<RecordTypeChoice> Choices(IEnumerable<string> types, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        [.. types
            .Select(type => new RecordTypeChoice(type, schemas.DisplayNameFor(type)))
            .OrderBy(r => r.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.Type, StringComparer.Ordinal)];

    public Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferences(string targetFormKey) =>
        _answer.Of(() => Referrers(RequireReads().GetReferencedBy(targetFormKey)));

    public Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferencesInActiveOrCompiledPlugins(string targetFormKey) =>
        _answer.Of(() => Referrers(RequireReads().GetReferencedByInActiveOrCompiledPlugins(targetFormKey)));

    private IReadOnlyList<ReferenceResult> Referrers(IReadOnlyList<ReferenceRow> rows)
    {
        var schemas = RequireSchemas();
        var snapshot = _loadOrder.Require();
        return [.. rows
            .OrderBy(r => snapshot.LoadOrderIndex(new PluginAddress(r.Plugin, r.Origin)) ?? int.MaxValue)
            .ThenBy(r => r.Origin, StringComparer.Ordinal)
            .ThenBy(r => r.Plugin, StringComparer.Ordinal)
            .Select(r => new ReferenceResult(
                r.FormKey, r.Plugin, r.Origin, r.FieldPath, r.RecordType, schemas.DisplayNameFor(r.RecordType), r.EditorId))];
    }

    // The record index stores each copy's document as the codec writes it, or a stub (ADR-0005).
    public Answer<RenderedDocument?, IndexRefused> GetRenderedDocument(PluginAddress plugin, string formKey) =>
        _answer.Sourced(() => RenderedDocumentOf(plugin, formKey));

    private Answer<RenderedDocument?, SourceFailure> RenderedDocumentOf(PluginAddress plugin, string formKey)
    {
        if (RequireReads().GetCopyText(formKey, plugin) is not var (identity, body)) return SourceAnswer.Of<RenderedDocument?>(null);
        return RenderedFileName(plugin, identity).Then(name => SourceAnswer.Of<RenderedDocument?>(new RenderedDocument(name, body)));
    }

    // A compiled plugin's truth is its tree (ADR-0006), so a copy whose file is gone has no answer.
    public Answer<CopyDocument?, IndexRefused> GetCopyDocument(PluginAddress plugin, string formKey) =>
        _answer.Sourced(() => CopyDocumentOf(plugin, formKey));

    private Answer<CopyDocument?, SourceFailure> CopyDocumentOf(PluginAddress plugin, string formKey)
    {
        if (RequireReads().GetCopyText(formKey, plugin) is not var (identity, _)) return SourceAnswer.Of<CopyDocument?>(null);
        if (TreeOf(plugin) is not { } tree)
        {
            return RenderedFileName(plugin, identity)
                .Then(name => SourceAnswer.Of<CopyDocument?>(new CopyDocument(CopyDocumentKind.Rendered, name)));
        }
        return tree.DocumentOf(plugin, identity).Then(file => SourceAnswer.Of(file is null ? null : CopyDocumentAt(file)));
    }

    private static CopyDocument CopyDocumentAt(DocumentFile file) =>
        new(file.IsContainersDocument ? CopyDocumentKind.ContainersFile : CopyDocumentKind.OwnFile, file.Path);

    // A compiled plugin copy's file may have been renamed outside Modbench (ADR-0003), so its name is the tree's.
    private Answer<string, SourceFailure> RenderedFileName(PluginAddress plugin, RecordIdentity identity)
    {
        var snapshot = _loadOrder.Require();
        if (snapshot.Plugin(plugin) is not { } registered || !source.IsSourceMod(registered)
            || source.Over(registered, snapshot.GameRelease) is not { } compiledPlugin)
        {
            return source.FileNameOf(identity);
        }
        return compiledPlugin.FileNameOf(plugin, identity).Then(name => SourceAnswer.Of(name ?? source.FileNameOf(identity)));
    }

    private ISourceRepositoryReads? TreeOf(PluginAddress plugin)
    {
        var snapshot = _loadOrder.Require();
        return snapshot.Plugin(plugin) is { } registered ? source.TreeOf(registered, snapshot.GameRelease) : null;
    }

    public Answer<RecordOfFileAnswer, IndexRefused> GetRecordOfFile(string path) =>
        _answer.Of(() => source.RecordOfFile(_loadOrder.Require(), path));

    public Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused> GetWorldspaces(PluginAddress plugin) =>
        _answer.Of(() => WorldspaceTree.WorldspacesOf(RequireReads(), plugin, _loadOrder.Require().GameRelease));

    public Answer<WorldspaceBlocks, IndexRefused> GetWorldspaceBlocks(PluginAddress plugin, string worldspaceFormKey) =>
        _answer.Of(() => WorldspaceTree.BlocksOf(RequireReads().GetWorldspaceCells(plugin, worldspaceFormKey)));

    public Answer<CellChildRecords, IndexRefused> GetCellChildRecords(PluginAddress plugin, string cellFormKey) =>
        _answer.Of(() => RequireReads().GetCellChildRecords(plugin, cellFormKey));

    public Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused> GetInteriorCells(PluginAddress plugin) =>
        _answer.Of(() => WorldspaceTree.InteriorBlocksOf(RequireReads().GetInteriorCells(plugin)));

    public Answer<IReadOnlyList<ContainerChildSummary>, IndexRefused> GetContainerChildren(PluginAddress plugin, string parentFormKey) =>
        _answer.Of(() => ContainerChildren.Of(RequireReads(), plugin, parentFormKey, _loadOrder.Require().GameRelease));

    // A plugin the record index has not reached holds no rows yet and would read clean.
    public Answer<IReadOnlyList<PluginDiagnosisReport>, IndexRefused> GetLoadOrderDiagnoses() =>
        _answer.Of(() => LoadOrderDiagnoses.Of(_index.RequireWholeSetReads(), _loadOrder.Require()));

    // A plugin the record index has not opened would read as no dependant.
    public Answer<PluginDependants, IndexRefused> GetDependants(PluginAddress plugin) =>
        _answer.Of(() =>
        {
            var opened = _index.RequireWholeSetReads().OpenedPlugins;
            return Dependants.Of(plugin, _loadOrder.Require(), opened);
        });

    public Answer<PluginIndexedState, IndexRefused> GetPluginIndexedAsOnDisk(PluginAddress plugin) =>
        _answer.Of(() => _index.IndexedState(plugin));

    // A plugin the record index has not reached holds no record yet, so every link into it would read as a
    // missing record.
    public Answer<IReadOnlyList<PluginProblems>, IndexRefused> GetProblems() =>
        _answer.Of(() => ProblemsPanel.Of(_index, _index.RequireWholeSetReads(), _loadOrder.Require(), source));

    public LoadOrderStatus GetStatus() => _index.Status;

    public long GetSequence() => _index.Sequence;

    public async Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout)
    {
        var reached = await _index.AwaitSequenceAsync(atLeast, timeout).ConfigureAwait(false);
        return new SequenceAwaitResponse(reached, _index.Sequence);
    }

    public Answer<RecordFilter?, IndexRefused> GetFilter() => _answer.Of(() =>
    {
        RequireReads();
        return filter.Current;
    });

    public IndexRefused? SetFilter(string sql, string source) => _answer.Refusing(() =>
        filter.Set(_index, sql, source) is { } rejection ? new IndexRefused(IndexRefusal.FilterRejected, rejection) : null);

    public void ClearFilter() => filter.Clear(_index);

    public Answer<SelectedRows, IndexRefused> SelectRows(string sql) => _answer.Flat<SelectedRows>(() =>
    {
        if (SqlDoor.Select(_index, sql).Holds(out var rows, out var rejection)) return new SelectedRows(rows);
        return new IndexRefused(IndexRefusal.SelectRejected, rejection);
    });

    public Answer<IReadOnlyList<NamedObject>, IndexRefused> ResolveNames(IReadOnlyList<NameQuery> names) =>
        _answer.Flat<IReadOnlyList<NamedObject>>(() =>
        {
            var reads = _index.RequireWholeSetReads();
            var snapshot = _loadOrder.Require();
            var matches = names.Select(query => (Query: query, Matches: NamedBy(query, snapshot, reads))).ToList();
            var unresolved = matches.Where(m => m.Matches.Count != 1).ToList();
            if (unresolved.Count > 0)
                return new IndexRefused(IndexRefusal.NameRefused, string.Join(" ", unresolved.Select(m => Unresolved(m.Query, m.Matches))));
            return matches.Select(m => m.Matches[0]).ToList();
        });

    private static List<NamedObject> NamedBy(NameQuery query, LoadOrderSnapshot snapshot, RelationReads reads)
    {
        var plugins = snapshot.Plugins
            .Where(p => string.Equals(p.Name, query.Name, StringComparison.OrdinalIgnoreCase)
                && (query.Origin is null || string.Equals(p.Origin, query.Origin, StringComparison.OrdinalIgnoreCase)))
            .Select(p => new NamedObject(p.Key, null, null));
        var records = query.Origin is null
            ? reads.RecordsNamed(query.Name).Select(r => new NamedObject(null, r.FormKey, r.EditorId))
            : [];
        return [.. plugins, .. records];
    }

    private static string Unresolved(NameQuery query, List<NamedObject> matches)
    {
        var given = query.Origin is null ? $"\"{query.Name}\"" : $"\"{query.Name}\" from {query.Origin}";
        if (matches.Count == 0) return $"Nothing is named {given}.";
        var listed = matches.Select(m => m.Plugin is { } plugin ? $"plugin {plugin.Name} (origin {plugin.Origin})" : $"record {m.FormKey}");
        return $"{given} means more than one thing: {string.Join("; ", listed)}.";
    }

    /// <summary>ADR-0010: drops the record index file and refills it off the caller's thread. A file another
    /// window holds, or a read that never ended, is refused.</summary>
    public StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot)
    {
        if (!_index.WhileClosed(file => file.Rebuild(gameRelease, instanceRoot), out var heldElsewhere))
        {
            return new(StoreRebuildRefusal.StillServingReads,
                IndexWriteGate.NotDrained("mEdit's record index was not rebuilt", "It is reopened as it was."));
        }
        return heldElsewhere is null ? null : new(StoreRebuildRefusal.HeldByAnotherWindow, heldElsewhere);
    }

    private static RecordDetail ToRecordDetail(RecordDocument document) =>
        new(document.FormKey, document.Plugin.Name, document.LoadOrderIndex, document.IsWinner, document.EditorId,
            document.Fields, Origin: document.Plugin.Origin, RecordType: document.RecordType,
            IsPartialForm: document.IsPartialForm,
            ParseDiagnosis: document.ParseDiagnosis,
            MissingStringsFile: document.MissingStringsFile,
            Templated: document.Templated);

    private bool Indexed => _index.Status.State == LoadOrderState.Ready;

    private RelationReads RequireReads() => _index.RequireReads();

    private IReadOnlyDictionary<string, RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(_loadOrder.Require().GameRelease);

    public void Dispose() => _index.Dispose();
}
