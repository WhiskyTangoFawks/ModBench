using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Index.Queries;

internal sealed class RecordQueryService(
    IQueryIndex index,
    LoadOrderHolder loadOrder,
    SchemaReflector schemaReflector,
    ISourceAdapter source,
    ILogger<RecordQueryService> logger) : IRecordQueryService
{
    private readonly ILogger _logger = logger;
    private readonly IQueryIndex _index = index;
    private readonly LoadOrderHolder _loadOrder = loadOrder;
    private readonly SchemaReflector _schemaReflector = schemaReflector;
    private const int NotInLoadOrder = int.MaxValue;

    private readonly ConflictClassifier _conflictClassifier = new ConflictClassifier(logger);

    public IReadOnlyList<PluginRow> GetPlugins()
    {
        var reads = RequireReads();
        var opened = reads.OpenedPlugins;
        // The rows and their order are the load order's; the facts reading the file yielded are the
        // Index's. A plugin the Index has not opened has none of the latter and is not a row.
        var snapshot = _loadOrder.Require();
        var rows = snapshot.Plugins.Where(c => opened.ContainsKey(c.Key)).ToList();
        var masterIssues = _index.Status.State == LoadOrderState.Ready
            ? MasterResolution.Classify(snapshot, opened)
            : null;
        var parseFailures = reads.GetPluginsWithParseFailures();
        var derivations = reads.GetDerivations();
        PluginRow ToRow(RegisteredPlugin plugin, bool hasMatchingRecords)
        {
            DerivedFrom? derivedFrom = derivations.TryGetValue(plugin.Key, out var stamped) ? stamped : null;
            return new(plugin, snapshot.LoadOrderIndex(plugin.Key), IsImmutable: snapshot.ProviderOf(plugin.Key) == PluginProvider.Game, opened[plugin.Key],
                masterIssues?.GetValueOrDefault(plugin.Key, []), hasMatchingRecords,
                parseFailures.Contains(plugin.Key),
                IsTracked: derivedFrom?.IsTracked() ?? false,
                PluginSourceUnreadable: derivedFrom == DerivedFrom.BinaryForUnreadableSource);
        }

        if (_index.ActiveFilter is null)
            return [.. rows.Select(c => ToRow(c, hasMatchingRecords: true))];

        // plugins.md: a record filter prunes records and record types, never
        // a plugin row — every plugin is still returned, and HasMatchingRecords is the additive fact
        // a caller decides expandability from, not row presence.
        var matchingPlugins = reads.GetPluginsWithMatchingRecords(RequireSchemas().Keys);
        return [.. rows.Select(c => ToRow(c, matchingPlugins.Contains(c.Key)))];
    }

    // The header is not a browsable record type: it stays a schemas.Keys entry so GetRecord/
    // GetCompare resolve it by FormKey, but both browse paths below exclude it.
    private static bool IsGroup(string recordType, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        recordType != PluginHeader.RecordType && schemas.ContainsKey(recordType);

    public PagedResult<RecordSummary> GetRecords(
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

    private string? FormKeyOfFormId(string? search, IRecordReads reads) =>
        search is null ? null : LoadIndex.FormKeyOf(search, _loadOrder.Require(), reads.OpenedPlugins)?.ToString();

    public RecordDetail? GetRecord(string formKey)
    {
        var document = _index.RequireWholeSetReads().GetDocument(formKey);
        return document == null ? null : ToRecordDetail(document);
    }

    public CompareResult? GetCompare(string formKey, CopyText? text = null)
    {
        var reads = RequireReads();
        var stack = reads.GetOverrideStack(formKey);
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

        return new CompareResult(annotated, classification.Diffs, conflictAll, RequireSchemas().DisplayNameFor(recordType));
    }

    public CompareResult GetCompareRecords(IReadOnlyList<RecordCopy> copies)
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
        if (missing.Count > 0) throw new RecordCopiesMissingException(missing);

        var records = documents.ConvertAll(ToRecordDetail);
        // Two copies may come from one plugin, so a column is named by its place as well.
        var columns = records.Select((r, i) => $"{i}#{ColumnKey.Of(r.Plugin, r.Origin)}").ToList();
        var diffs = _conflictClassifier.Align(
            records, columns, snapshot.GameRelease, reads.LinkResolver(copies[0].FormKey), LoadIndex.FormIdsOf(snapshot, reads.OpenedPlugins));
        var overrides = records.Select((r, i) => ToCompareOverride(r, state: null, columns[i], snapshot, reads)).ToList();

        return new CompareResult(overrides, diffs, ConflictAll.NoConflict, RequireSchemas().DisplayNameFor(documents[0].RecordType));
    }

    // The text is the document carrying the record. A plugin's source tree says which document that is, as it
    // does for an edit; a plugin with no tree has only the record's own.
    private RecordDocument? CopyFromText(
        IRecordReads reads, string formKey, PluginAddress plugin, int loadOrderIndex, string text)
    {
        if (TreeOf(plugin) is not { } tree)
            return reads.DocumentFromText(formKey, plugin, loadOrderIndex, text);

        try
        {
            return tree.RecordFromText(plugin, formKey, text, RequireSchemas()) is { } record
                ? reads.DocumentFromText(formKey, plugin, loadOrderIndex, record.Body)
                : Unread(reads, formKey, plugin, loadOrderIndex, $"No document in {plugin.Name}'s source tree carries {formKey}.");
        }
        catch (Exception refused) when (refused is UnreadableSourceDocumentException or AmbiguousSourceUnitException)
        {
            _logger.LogWarning(refused, "{FormKey} in {Plugin} cannot be read from its source tree: {Cause}", formKey, plugin.Name, refused.Message);
            return Unread(reads, formKey, plugin, loadOrderIndex, refused.Message);
        }
    }

    private static RecordDocument? Unread(IRecordReads reads, string formKey, PluginAddress plugin, int loadOrderIndex, string why) =>
        reads.DocumentFromText(formKey, plugin, loadOrderIndex, CallerText.NoBody) is { } unread ? unread with { ParseDiagnosis = why } : null;

    private static CompareOverride ToCompareOverride(
        RecordDetail o, ConflictThis? state, string? column, LoadOrderSnapshot snapshot, IRecordReads reads) =>
        new(o.FormKey, o.Plugin, o.LoadOrderIndex, o.IsWinner, o.EditorId, o.Fields, state,
            Origin: o.Origin,
            LoadIndex: LoadIndex.Of(new PluginAddress(o.Plugin, o.Origin), o.LoadOrderIndex, snapshot, reads.OpenedPlugins),
            RecordType: o.RecordType, IsPartialForm: o.IsPartialForm, ParseDiagnosis: o.ParseDiagnosis,
            IsInOverwrite: snapshot.ProviderOf(new PluginAddress(o.Plugin, o.Origin)) == PluginProvider.NoMod,
            Column: column);

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
                committedOverrides, release, resolveFormKey, loadOrderFormIds, _index.Status.State == LoadOrderState.Ready, outsideTheComparison)
            : new ClassifyResult(
                ConflictAll.NoConflict, new Dictionary<string, ConflictThis>(),
                _conflictClassifier.Align(
                    outsideTheComparison, [.. (outsideTheComparison).Select(r => ColumnKey.Of(r.Plugin, r.Origin))],
                    release, resolveFormKey, loadOrderFormIds));
        return (classification, classification.ConflictAll);
    }

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(PluginAddress plugin)
    {
        var reads = RequireReads();
        var schemas = RequireSchemas();
        var release = _loadOrder.Require().GameRelease;

        return [.. reads.GetRecordTypeCounts(plugin)
            .Where(c => IsGroup(c.Type, schemas))
            .Select(c => new PluginRecordTypeCount(
                c.Type, c.Count, schemas.DisplayNameFor(c.Type), c.HasParseFailure,
                CreatableRecordTypes.Includes(c.Type, release), ContainerChildFields.HasChildFields(c.Type, release)))
            .OrderBy(r => r.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.Type, StringComparer.Ordinal)];
    }

    public WorkingTreeStatesBeneath GetWorkingTreeStatesBeneath(PluginAddress plugin) =>
        RequireReads().GetWorkingTreeStatesBeneath(plugin);

    public IReadOnlyList<RecordTypeChoice> GetCreatableRecordTypes()
    {
        var schemas = RequireSchemas();
        return Choices(CreatableRecordTypes.Of(schemas, _loadOrder.Require().GameRelease), schemas);
    }

    public IReadOnlyList<RecordTypeChoice>? GetChildRecordTypes(PluginAddress plugin, string formKey)
    {
        var reads = RequireReads();
        if (reads.GetDocument(formKey, plugin) is not { Body: { } body } container) return null;
        var schemas = RequireSchemas();
        var place = reads.GetCellLocation(plugin, formKey) is { } cell
            ? new CellStructure(cell.ParentWorldspace, cell.BlockX, cell.BlockY, cell.SubX, cell.SubY, cell.IsInterior).Place
            : (CellPlace?)null;
        return Choices(ChildRecordTypes.Of(container.RecordType, body, place, schemas, _loadOrder.Require().GameRelease), schemas);
    }

    // Sorted as a plugin's groups are, so the pick reads in the order the tree shows.
    private static List<RecordTypeChoice> Choices(IEnumerable<string> types, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        [.. types
            .Select(type => new RecordTypeChoice(type, schemas.DisplayNameFor(type)))
            .OrderBy(r => r.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.Type, StringComparer.Ordinal)];

    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) =>
        Referrers(RequireReads().GetReferencedBy(targetFormKey));

    public IReadOnlyList<ReferenceResult> GetReferencesInActiveOrTrackedPlugins(string targetFormKey) =>
        Referrers(RequireReads().GetReferencedByInActiveOrTrackedPlugins(targetFormKey));

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

    // The index stores each copy's document as the codec writes it, or a stub (ADR-0005).
    public RenderedDocument? GetRenderedDocument(PluginAddress plugin, string formKey)
    {
        if (RequireReads().GetCopyText(formKey, plugin) is not var (identity, body)) return null;
        return new RenderedDocument(RenderedFileName(plugin, identity), body);
    }

    // A tracked plugin's truth is its tree (ADR-0006), so a copy whose file is gone has no answer.
    public CopyDocument? GetCopyDocument(PluginAddress plugin, string formKey)
    {
        if (RequireReads().GetCopyText(formKey, plugin) is not var (identity, _)) return null;
        if (TreeOf(plugin) is not { } tree)
            return new CopyDocument(CopyDocumentKind.Rendered, RenderedFileName(plugin, identity));
        if (tree.DocumentOf(plugin, identity) is not { } file) return null;
        var kind = file.IsContainersDocument ? CopyDocumentKind.ContainersFile : CopyDocumentKind.OwnFile;
        return new CopyDocument(kind, file.Path);
    }

    // A tracked copy's file may have been renamed outside Modbench (ADR-0003), so its name is the tree's.
    private string RenderedFileName(PluginAddress plugin, RecordIdentity identity)
    {
        var snapshot = _loadOrder.Require();
        var tracked = snapshot.Plugin(plugin) is { } registered && source.IsTracked(registered)
            ? source.Over(registered, snapshot.GameRelease)
            : null;
        return tracked?.FileNameOf(plugin, identity) ?? source.FileNameOf(identity);
    }

    private ISourceRepositoryReads? TreeOf(PluginAddress plugin)
    {
        var snapshot = _loadOrder.Require();
        return snapshot.Plugin(plugin) is { } registered ? source.TreeOf(registered, snapshot.GameRelease) : null;
    }

    public RecordOfFileAnswer GetRecordOfFile(string path) => source.RecordOfFile(_loadOrder.Require(), path);

    public LoadOrderStatus GetStatus() => _index.Status;

    public long GetSequence() => _index.Sequence;

    public async Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout)
    {
        var reached = await _index.AwaitSequenceAsync(atLeast, timeout).ConfigureAwait(false);
        return new SequenceAwaitResponse(reached, _index.Sequence);
    }

    public (string Sql, string Source)? GetFilter()
    {
        RequireReads();
        return _index.ActiveFilter;
    }

    public void SetFilter(string sql, string source) => _index.SetFilter(sql, source);

    public void ClearFilter() => _index.ClearFilter();

    public StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot)
    {
        if (SourceRepository.InstanceRootNotFound(instanceRoot) is { } notFound)
            return new(StoreRebuildRefusal.InstanceRootNotFound, notFound);
        return _index.RebuildStore(gameRelease, instanceRoot) is { } heldElsewhere
            ? new(StoreRebuildRefusal.HeldByAnotherWindow, heldElsewhere)
            : null;
    }

    private static RecordDetail ToRecordDetail(RecordDocument document) =>
        new(document.FormKey, document.Plugin.Name, document.LoadOrderIndex, document.IsWinner, document.EditorId,
            document.Fields, Origin: document.Plugin.Origin, RecordType: document.RecordType,
            IsPartialForm: document.IsPartialForm,
            ParseDiagnosis: document.ParseDiagnosis);

    private IRecordReads RequireReads() => _index.RequireReads();

    private IReadOnlyDictionary<string, RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(_loadOrder.Require().GameRelease);
}
