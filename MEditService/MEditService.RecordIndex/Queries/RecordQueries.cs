using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Store;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Assets;
using Mutagen.Bethesda.Plugins;

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
    private readonly ChangedOutside _changedOutside = new();
    private readonly IndexAnswer _answer = new(index.RecoverFromInvalidation);
    private readonly LoadOrderHolder _loadOrder = loadOrder;
    private readonly SchemaReflector _schemaReflector = schemaReflector;
    private const int NotInLoadOrder = int.MaxValue;

    private readonly ConflictClassifier _conflictClassifier = new ConflictClassifier(logger);

    public Answer<IReadOnlyList<PluginResponse>, IndexRefused> GetPlugins(IReadOnlyCollection<PluginAddress>? plugins, CancellationToken cancel) =>
        _answer.Of(() => PluginResponses(plugins, cancel));

    private IReadOnlyList<PluginResponse> PluginResponses(IReadOnlyCollection<PluginAddress>? named, CancellationToken cancel)
    {
        if (_index.Rebuilding) return [];
        using var reads = RequireReads(cancel, inOneSnapshot: true);
        var opened = reads.OpenedPlugins;
        // The rows and their order are the load order's; the facts reading the file yielded are the
        // Index's. A plugin the Index has not opened has none of the latter and is not a row.
        var snapshot = _loadOrder.Require();
        var asked = named is null ? null : new HashSet<PluginAddress>(named, PluginAddress.Comparer);
        var rows = snapshot.Plugins.Where(c => opened.ContainsKey(c.Key) && (asked?.Contains(c.Key) ?? true)).ToList();
        var parseFailures = reads.GetPluginsWithParseFailures();
        var derivations = reads.GetDerivations();
        PluginResponse ToResponse(RegisteredPlugin plugin, bool hasMatchingRecords)
        {
            DerivedFrom? derivedFrom = derivations.TryGetValue(plugin.Key, out var stamped) ? stamped : null;
            var content = opened[plugin.Key];
            var loadOrderIndex = snapshot.LoadOrderIndex(plugin.Key);
            return new(plugin.Name, plugin.Path, loadOrderIndex, content.IsLight, content.IsMaster, content.IsBlueprint,
                content.Masters, IsImmutable: snapshot.ProviderOf(plugin.Key) == PluginProvider.Game, plugin.Origin,
                InLoadOrder: loadOrderIndex is not null, hasMatchingRecords,
                IsCompiledPlugin: derivedFrom?.IsSourceMod() ?? false,
                HasParseFailure: parseFailures.Contains(plugin.Key),
                PluginSourceUnreadable: derivedFrom == DerivedFrom.BinaryForUnreadableSource ? WhyUnreadable(plugin) : null,
                _index.LaterReadFailure(plugin.Key)?.Select(SourceProblem.StoppedAt).ToList(),
                content.Description);
        }

        if (filter.Current is null)
            return [.. rows.Select(c => ToResponse(c, hasMatchingRecords: true))];

        // plugins.md: a record filter prunes records and record types, never
        // a plugin row — every plugin is still returned, and HasMatchingRecords is the additive fact
        // a caller decides expandability from, not row presence.
        var matchingPlugins = reads.GetPluginsWithMatchingRecords(RequireSchemas().Keys, [.. rows.Select(row => row.Key)]);
        return [.. rows.Select(c => ToResponse(c, matchingPlugins.Contains(c.Key)))];
    }

    private UnreadableSource WhyUnreadable(RegisteredPlugin plugin) =>
        source.WhySourceDoesNotRead(plugin) is { } failure ? UnreadableSources.Of(failure)
        : _index.WhyTreeStopped(plugin.Key) ?? UnreadableSources.Unknown;

    // The header is not a browsable record type: it stays a schemas.Keys entry so GetCompare
    // resolves it by FormKey, but both browse paths below exclude it.
    private static bool IsGroup(string recordType, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        recordType != PluginHeader.RecordType && schemas.ContainsKey(recordType);

    public Answer<PagedResult<RecordSummary>, IndexRefused> GetRecords(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset, CancellationToken cancel) =>
        _answer.Of(() => RecordPage(types, plugin, search, limit, offset, cancel));

    private PagedResult<RecordSummary> RecordPage(
        IReadOnlyList<string>? types, PluginAddress? plugin, string? search, int limit, int offset, CancellationToken cancel)
    {
        using var reads = RequireReads(cancel);
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

    public Answer<IReadOnlyList<PluginAddress>, IndexRefused> GetRecordOwners(string formKey, CancellationToken cancel) =>
        _answer.Of(() => ReadingWholeSet(reads => reads.GetOwners(formKey), cancel));

    public Answer<CompareResult?, IndexRefused> GetCompare(string formKey, CopyText? text, CancellationToken cancel) =>
        _answer.Of(() => CompareOf(formKey, text, cancel));

    private CompareResult? CompareOf(string formKey, CopyText? text, CancellationToken cancel)
    {
        using var reads = RequireReads(cancel, inOneSnapshot: true);
        var recordText = text is null ? (RecordText?)null : TextOfRecord(formKey, text.Plugin, text.DocumentText);
        var resolver = reads.NewLinkResolver();
        var stack = text?.Alone == true ? null : reads.GetOverrideStack(formKey, resolver);
        if (stack == null && text == null) return null;
        var snapshot = _loadOrder.Require();

        var active = stack?.Entries.Select(e => e.Effective).ToList() ?? [];
        var outside = new List<RecordDocument>();
        if (text is not null && recordText is { } read)
        {
            var at = active.FindIndex(c => PluginAddress.Comparer.Equals(c.Plugin, text.Plugin));
            var loadOrderIndex = at >= 0 ? active[at].LoadOrderIndex : snapshot.LoadOrderIndex(text.Plugin) ?? NotInLoadOrder;
            var fromText = CopyFromText(reads, formKey, text.Plugin, loadOrderIndex, read, resolver);
            if (fromText is null) return null;
            if (at >= 0) active[at] = fromText with { IsWinner = active[at].IsWinner };
            else outside.Add(fromText);
        }
        var recordType = (active.Count > 0 ? active[0] : outside[0]).RecordType;

        var formIds = LoadIndex.FormIdsOf(snapshot, reads.OpenedPlugins);
        var overrides = active.ConvertAll(ToRecordDetail);
        var outsideTheComparison = outside.ConvertAll(ToRecordDetail);
        var (classification, conflictAll) = ClassifyStack(overrides, resolver.Resolve, formIds, outsideTheComparison);
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

    public Answer<CompareRecordsAnswer, IndexRefused> GetCompareRecords(IReadOnlyList<RecordCopy> copies, CancellationToken cancel) =>
        _answer.Of(() => CompareCopies(copies, cancel));

    private CompareRecordsAnswer CompareCopies(IReadOnlyList<RecordCopy> copies, CancellationToken cancel)
    {
        using var reads = _index.RequireWholeSetReads(cancel, inOneSnapshot: true);
        var snapshot = _loadOrder.Require();
        List<RecordText?> texts = [.. copies.Select(copy => copy.DocumentText is { } text ? TextOfRecord(copy.FormKey, copy.Plugin, text) : (RecordText?)null)];

        var (fromIndex, resolver) = reads.GetDocuments(copies);
        var documents = new List<RecordDocument>(copies.Count);
        var missing = new List<RecordCopy>();
        for (var i = 0; i < copies.Count; i++)
        {
            var copy = copies[i];
            var document = texts[i] is { } text
                ? CopyFromText(reads, copy.FormKey, copy.Plugin, snapshot.LoadOrderIndex(copy.Plugin) ?? NotInLoadOrder, text, resolver)
                : fromIndex[i];
            if (document == null) missing.Add(copy);
            else documents.Add(document);
        }
        if (missing.Count > 0)
            return CompareRecordsAnswer.CopiesMissing([.. missing.Select(c => CopyMissingFor(reads, c))]);

        var records = documents.ConvertAll(ToRecordDetail);
        // Two copies may come from one plugin, so a column is named by its place as well.
        var columns = records.Select((r, i) => $"{i}#{ColumnKey.Of(r.Plugin, r.Origin)}").ToList();
        var diffs = _conflictClassifier.Align(
            records, columns, snapshot.GameRelease, snapshot.StringsLanguage, resolver.Resolve, LoadIndex.FormIdsOf(snapshot, reads.OpenedPlugins),
            indexed: true);
        var overrides = records.Select((r, i) => ToCompareOverride(r, state: null, columns[i], snapshot, reads)).ToList();

        var conflictAll = ConflictRules.Worst(ConflictAll.NoConflict, diffs.Select(diff => diff.ConflictAll));
        return CompareRecordsAnswer.Compared(
            ComparisonOf(overrides, diffs, conflictAll, documents[0].RecordType, snapshot));
    }

    public Answer<IReadOnlyList<RecordCopyStates>, IndexRefused> GetCopyStates(
        IReadOnlyList<string> formKeys, PluginAddress? plugin, CancellationToken cancel) =>
        _answer.Flat(() => CopyStatesOf(formKeys, plugin, cancel));

    private Answer<IReadOnlyList<RecordCopyStates>, IndexRefused> CopyStatesOf(IReadOnlyList<string> formKeys, PluginAddress? plugin, CancellationToken cancel)
    {
        using var reads = _index.RequireWholeSetReads(cancel);
        var snapshot = _loadOrder.Require();
        if (plugin is { } judged && !snapshot.Active.Any(active => PluginAddress.Comparer.Equals(active.Key, judged)))
            return new IndexRefused(IndexRefusal.NameRefused, $"{judged.Name} ({judged.Origin}) is not active.");

        var formIds = LoadIndex.FormIdsOf(snapshot, reads.OpenedPlugins);
        var copyStates = new Dictionary<string, IReadOnlyList<CopyState>>(StringComparer.OrdinalIgnoreCase);
        foreach (var (formKey, documents) in reads.GetStacks(formKeys, plugin))
        {
            var states = _conflictClassifier.StatesOf([.. documents.Select(ToRecordDetail)], snapshot.GameRelease, snapshot.StringsLanguage, formIds);
            copyStates[formKey] = [.. documents.Select((d, i) => new CopyState(d.Plugin, states[i]))];
        }
        return formKeys.Select(formKey => new RecordCopyStates(formKey, copyStates.GetValueOrDefault(formKey) ?? [])).ToList();
    }

    private readonly record struct RecordText(string Text, string? WhyUnread);

    // The text is the document carrying the record. A plugin's source tree says which document that is, as it
    // does for an edit; a plugin with no tree has only the record's own. Read before any snapshot opens.
    private RecordText TextOfRecord(string formKey, PluginAddress plugin, string text)
    {
        if (TreeOf(plugin) is not { } tree) return new(text, null);

        if (!tree.RecordFromText(plugin, formKey, text).Holds(out var record, out var refused))
        {
            _logger.LogWarning("{FormKey} in {Plugin} cannot be read from its source tree: {Cause}", formKey, plugin.Name, refused.Reason);
            return new(CallerText.NoBody, refused.Reason);
        }
        return record is not null
            ? new(record.Body, null)
            : new(CallerText.NoBody, $"No document in {plugin.Name}'s source tree carries {formKey}.");
    }

    private static RecordDocument? CopyFromText(
        RelationReads reads, string formKey, PluginAddress plugin, int loadOrderIndex, RecordText text,
        LinkResolver resolver)
    {
        var document = reads.DocumentFromText(formKey, plugin, loadOrderIndex, text.Text, resolver);
        return text.WhyUnread is { } why && document is not null ? document with { ParseDiagnosis = why } : document;
    }

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
        var snapshot = _loadOrder.Require();
        // With no active copy there is nothing to compare: the copy outside it stands alone.
        var classification = committedOverrides.Count > 0
            ? _conflictClassifier.Classify(
                committedOverrides, snapshot.GameRelease, snapshot.StringsLanguage, resolveFormKey, loadOrderFormIds, Indexed, outsideTheComparison)
            : new ClassifyResult(
                ConflictAll.NoConflict, new Dictionary<string, ConflictThis>(),
                _conflictClassifier.Align(
                    outsideTheComparison, [.. (outsideTheComparison).Select(r => ColumnKey.Of(r.Plugin, r.Origin))],
                    snapshot.GameRelease, snapshot.StringsLanguage, resolveFormKey, loadOrderFormIds, Indexed));
        return (classification, classification.ConflictAll);
    }

    public Answer<IReadOnlyList<PluginRecordTypeCount>, IndexRefused> GetPluginRecordTypes(PluginAddress plugin, CancellationToken cancel) =>
        _answer.Of(() => RecordTypeCounts(plugin, cancel));

    private IReadOnlyList<PluginRecordTypeCount> RecordTypeCounts(PluginAddress plugin, CancellationToken cancel)
    {
        using var reads = RequireReads(cancel);
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

    public Answer<WorkingTreeStatesBeneath, IndexRefused> GetWorkingTreeStatesBeneath(PluginAddress plugin, CancellationToken cancel) =>
        _answer.Of(() => Reading(reads => reads.GetWorkingTreeStatesBeneath(plugin), cancel));

    public Answer<IReadOnlyList<RecordTypeChoice>, IndexRefused> GetCreatableRecordTypes() => _answer.Of<IReadOnlyList<RecordTypeChoice>>(() =>
    {
        var schemas = RequireSchemas();
        return Choices(RecordTypes.For(_loadOrder.Require().GameRelease).Creatable, schemas);
    });

    public Answer<IReadOnlyList<string>, IndexRefused> GetCreatablePluginExtensions() =>
        _answer.Of(() => CreatablePluginExtensions.Of(_loadOrder.Require().GameRelease));

    public Answer<IReadOnlyList<IReadOnlyList<string>>, IndexRefused> GetCreatablePluginFlags(string name) =>
        _answer.Flat<IReadOnlyList<IReadOnlyList<string>>>(() =>
        {
            var release = _loadOrder.Require().GameRelease;
            return ModKey.TryFromFileName(name, out var modKey)
                ? CreatablePluginFlags.Names(CreatablePluginFlags.Of(release, modKey.Type)).ToList()
                : new IndexRefused(IndexRefusal.NameRefused, $"{name} is not a plugin file name.");
        });

    public Answer<IReadOnlyList<RecordTypeChoice>?, IndexRefused> GetChildRecordTypes(
        PluginAddress plugin, string formKey, CancellationToken cancel) =>
        _answer.Of<IReadOnlyList<RecordTypeChoice>?>(() => ChildRecordTypesOf(plugin, formKey, cancel));

    private List<RecordTypeChoice>? ChildRecordTypesOf(PluginAddress plugin, string formKey, CancellationToken cancel)
    {
        using var reads = RequireReads(cancel, inOneSnapshot: true);
        if (reads.GetCopyText(formKey, plugin) is not var (identity, body)) return null;
        var schemas = RequireSchemas();
        var place = reads.GetCellLocation(plugin, formKey)?.Place;
        var held = reads.GetEveryHolding(plugin, formKey).Select(holding => (holding.Slot, holding.Child));
        return Choices(ChildRecordTypes.Of(identity.RecordType, body, held, place, _loadOrder.Require().GameRelease), schemas);
    }

    // Sorted as a plugin's groups are, so the pick reads in the order the tree shows.
    private static List<RecordTypeChoice> Choices(IEnumerable<string> types, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        [.. types
            .Select(type => new RecordTypeChoice(type, schemas.DisplayNameFor(type)))
            .OrderBy(r => r.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.Type, StringComparer.Ordinal)];

    public Answer<IReadOnlyList<ReferenceResult>, IndexRefused> GetReferencesInActiveOrCompiledPlugins(
        string targetFormKey, CancellationToken cancel) =>
        _answer.Of(() => Referrers(Reading(reads => reads.GetReferencedByInActiveOrCompiledPlugins(targetFormKey), cancel)));

    public Answer<PlacedReferences, IndexRefused> GetPlacedReferences(string targetFormKey, CancellationToken cancel) =>
        _answer.Of(() =>
        {
            using var reads = _index.RequireWholeSetReads(cancel, inOneSnapshot: true);
            var referrers = reads.GetReferencedByInActiveOrCompiledPlugins(targetFormKey)
                .Select(row => new Referrer(new RecordAt(new PluginAddress(row.Plugin, row.Origin), row.FormKey), new RecordIdentity(row.FormKey, row.RecordType, row.EditorId)));
            return Placed(reads, targetFormKey, referrers, [],
                (copy, names) => names.Where(name => name.Kind == DocumentNameKind.Record && name.FieldPath != RecordMembers.FormKey && string.Equals(name.Value, targetFormKey, StringComparison.OrdinalIgnoreCase)),
                false, _ => null, cancel);
        });

    public Answer<PlacedReferences, IndexRefused> GetPlacedPluginNameReferences(string name, CancellationToken cancel) =>
        _answer.Of(() =>
        {
            using var reads = _index.RequireWholeSetReads(cancel, inOneSnapshot: true);
            var referrers = reads.GetCopiesNaming(name).Select(found => new Referrer(new RecordAt(found.Copy.Plugin, found.Copy.FormKey), found.Identity));
            return Placed(reads, name, referrers, [],
                (copy, names) => names.Where(found => found.Kind == DocumentNameKind.Plugin && string.Equals(found.Value, name, StringComparison.OrdinalIgnoreCase)),
                true, _ => null, cancel);
        });

    public Answer<PlacedReferences, IndexRefused> GetPlacedScriptReferences(string name, CancellationToken cancel) =>
        _answer.Of(() =>
        {
            using var reads = _index.RequireWholeSetReads(cancel, inOneSnapshot: true);
            return PlacedMembers(reads, name, reads.GetScriptAttachments(name), cancel);
        });

    // Every path that names the file holds its name.
    public Answer<PlacedReferences, IndexRefused> GetPlacedFileReferences(string dataPath, CancellationToken cancel) =>
        _answer.Of(() =>
        {
            using var reads = _index.RequireWholeSetReads(cancel, inOneSnapshot: true);
            var file = new DataRelativePath(dataPath).Path.Replace('\\', '/');
            var name = dataPath[(dataPath.LastIndexOfAny(PathSeparators) + 1)..];
            return PlacedMembers(reads, dataPath, reads.GetFileNamings(file, name), cancel);
        });

    private PlacedReferences PlacedMembers(RelationReads reads, string symbol, IReadOnlyList<NamedAt> named, CancellationToken cancel)
    {
        var members = MemberReferencesOf(named);
        var fieldPaths = members.Copies.ToDictionary(copy => new RecordAt(copy.Plugin, copy.FormKey), copy => copy.FieldPaths, RecordAt.Comparer);
        var types = members.Copies.GroupBy(copy => copy.FormKey, StringComparer.OrdinalIgnoreCase).ToDictionary(copies => copies.Key, copies => copies.First().RecordType, StringComparer.OrdinalIgnoreCase);
        var schemas = RequireSchemas();
        var referrers = members.Copies.Select(copy => new Referrer(new RecordAt(copy.Plugin, copy.FormKey), new RecordIdentity(copy.FormKey, copy.RecordType, copy.EditorId)));
        return Placed(reads, symbol, referrers, members.Unread,
            (copy, names) => names.Where(found => found.Kind is DocumentNameKind.Script or DocumentNameKind.File
                && fieldPaths[copy].Contains(found.FieldPath ?? "")),
            true, formKey => types.TryGetValue(formKey, out var type) && schemas.TryGetValue(type, out var schema) ? schema.RecordColumns : null, cancel);
    }

    private PlacedReferences Placed(
        RelationReads reads, string symbol, IEnumerable<Referrer> referrers, IEnumerable<string> unread, NamesOf namesOf, bool atStartWhereRenderedNamesNothing,
        Func<string, IReadOnlyList<ColumnSpec>?> columnsOf, CancellationToken cancel) =>
        ReferencePlacement.Of(
            reads, symbol, referrers, unread, namesOf, atStartWhereRenderedNamesNothing, TreeOf, (plugin, identity) => RenderedFileName(plugin, identity, identity), source.TextAt, columnsOf, cancel);

    // A plugin the record index has not reached would read as naming nothing.
    public Answer<IReadOnlyList<CopyNaming>, IndexRefused> GetPluginNameReferences(string name, CancellationToken cancel) =>
        _answer.Of(() => (IReadOnlyList<CopyNaming>)[.. ReadingWholeSet(reads => reads.GetCopiesNaming(name), cancel).Select(found => found.Copy)]);

    public Answer<IReadOnlyList<RecordAt>, IndexRefused> GetCopiesWithNoPluginSourceNaming(PluginAddress plugin, string formKey, CancellationToken cancel) => _answer.Of(() =>
    {
        var snapshot = _loadOrder.Require();
        return (IReadOnlyList<RecordAt>)[.. ReadingWholeSet(reads => reads.GetCopiesWithNoPluginSourceNaming(formKey), cancel)
            .Where(copy => snapshot.NamesRecordsOf(plugin, copy.Plugin))];
    });

    public Answer<MemberReferences, IndexRefused> GetScriptReferences(string name, CancellationToken cancel) =>
        _answer.Of(() => MemberReferencesOf(ReadingWholeSet(reads => reads.GetScriptAttachments(name), cancel)));

    private static readonly char[] PathSeparators = ['/', '\\'];

    private static MemberReferences MemberReferencesOf(IReadOnlyList<NamedAt> named) =>
        new(
            [.. named.Where(found => found.Row.Refusal is null)
                .GroupBy(found => new RecordAt(found.Plugin, found.Row.FormKey), RecordAt.Comparer)
                .Select(copy =>
                {
                    var first = copy.First();
                    return new CopyNamingAtMembers(
                        first.Row.FormKey, first.Plugin, first.InPluginSource, [.. copy.Select(found => found.Row.FieldPath)], first.Row.RecordType, first.Row.EditorId);
                })],
            [.. named.Where(found => found.Row.Refusal is not null)
                .Select(found => $"{ReadFailures.Copy(found.Row.FormKey, found.Plugin)}: {found.Row.FieldPath}: {found.Row.Refusal}")]);

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
    public Answer<RenderedDocument?, IndexRefused> GetRenderedDocument(PluginAddress plugin, string formKey, CancellationToken cancel) =>
        _answer.Sourced(() => RenderedDocumentOf(plugin, formKey, cancel));

    private Answer<RenderedDocument?, SourceFailure> RenderedDocumentOf(PluginAddress plugin, string formKey, CancellationToken cancel)
    {
        if (CopyAndItsCarryingRecord(plugin, formKey, cancel) is not var (identity, body, carrying)) return SourceAnswer.Of<RenderedDocument?>(null);
        return RenderedFileName(plugin, identity, carrying).Then(name => SourceAnswer.Of<RenderedDocument?>(new RenderedDocument(name, body)));
    }

    // The record index names an embedded copy's carrying record, so the tree is never searched for it.
    private (RecordIdentity Identity, string Body, RecordIdentity Carrying)? CopyAndItsCarryingRecord(PluginAddress plugin, string formKey, CancellationToken cancel)
    {
        using var reads = RequireReads(cancel, inOneSnapshot: true);
        if (reads.GetCopyText(formKey, plugin) is not var (identity, body)) return null;
        return (identity, body, reads.GetCarryingRecord(formKey, plugin) ?? identity);
    }

    // A compiled plugin's truth is its tree (ADR-0006), so a copy whose file is gone has no answer.
    public Answer<CopyDocument?, IndexRefused> GetCopyDocument(PluginAddress plugin, string formKey, CancellationToken cancel) =>
        _answer.Sourced(() => Reading(reads => reads.GetCopyText(formKey, plugin), cancel) is not var (identity, _)
            ? SourceAnswer.Of<CopyDocument?>(null)
            : CopyDocumentOf(plugin, identity));

    public Answer<CopyDocument?, IndexRefused> GetCopyDocument(PluginAddress plugin, RecordIdentity identity, CancellationToken cancel) =>
        _answer.Sourced(() =>
        {
            cancel.ThrowIfCancellationRequested();
            return CopyDocumentOf(plugin, identity);
        });

    private Answer<CopyDocument?, SourceFailure> CopyDocumentOf(PluginAddress plugin, RecordIdentity identity)
    {
        if (TreeOf(plugin) is not { } tree)
        {
            return RenderedFileName(plugin, identity, identity)
                .Then(name => SourceAnswer.Of<CopyDocument?>(new CopyDocument(CopyDocumentKind.Rendered, name)));
        }
        return tree.DocumentOf(plugin, identity).Then(file => SourceAnswer.Of(file is null ? null : CopyDocumentAt(file)));
    }

    internal static CopyDocument CopyDocumentAt(DocumentFile file) =>
        new(file.IsContainersDocument ? CopyDocumentKind.ContainersFile : CopyDocumentKind.OwnFile, file.Path);

    // A compiled plugin copy's file may have been renamed outside Modbench (ADR-0003), so its name is the tree's: the
    // name of its carrying record's document.
    private Answer<string, SourceFailure> RenderedFileName(PluginAddress plugin, RecordIdentity identity, RecordIdentity carrying)
    {
        var snapshot = _loadOrder.Require();
        if (snapshot.Plugin(plugin) is not { } registered || !source.IsSourceMod(registered)
            || source.Over(registered, snapshot.GameRelease) is not { } compiledPlugin)
        {
            return source.FileNameOf(identity);
        }
        return compiledPlugin.FileNameOf(plugin, carrying).Then(name => SourceAnswer.Of(name ?? source.FileNameOf(identity)));
    }

    private ISourceRepositoryReads? TreeOf(PluginAddress plugin)
    {
        var snapshot = _loadOrder.Require();
        return snapshot.Plugin(plugin) is { } registered ? source.TreeOf(registered, snapshot.GameRelease) : null;
    }

    public Answer<RecordOfFileAnswer, IndexRefused> GetRecordOfFile(string path) =>
        _answer.Of(() => source.RecordOfFile(_loadOrder.Require(), path));

    public Answer<IReadOnlyList<DocumentName>, IndexRefused> GetPluginSourceNames(string? path, string text, int? at, CancellationToken cancel) =>
        _answer.Of(() =>
        {
            if (path is not null && source.Touching(_loadOrder.Require(), path) is not PathAnswer.Touches)
                return (IReadOnlyList<DocumentName>)[];
            var document = DocumentSpans.Read(text);
            var schemas = RequireSchemas();
            var types = Reading(reads => reads.RecordTypesOf([.. document.RecordFormKeys]), cancel);
            return DocumentNames.In(document, formKey => types.TryGetValue(formKey, out var type) && schemas.TryGetValue(type, out var schema) ? schema.RecordColumns : null, at);
        });

    public Answer<IReadOnlyList<WorldspaceSummary>, IndexRefused> GetWorldspaces(PluginAddress plugin, CancellationToken cancel) =>
        _answer.Of(() =>
        {
            using var reads = RequireReads(cancel, inOneSnapshot: true);
            return WorldspaceTree.WorldspacesOf(reads, plugin, _loadOrder.Require().GameRelease);
        });

    public Answer<WorldspaceBlocks, IndexRefused> GetWorldspaceBlocks(
        PluginAddress plugin, string worldspaceFormKey, CancellationToken cancel) =>
        _answer.Of(() => WorldspaceTree.BlocksOf(Reading(reads => reads.GetWorldspaceCells(plugin, worldspaceFormKey), cancel)));

    public Answer<CellChildRecords, IndexRefused> GetCellChildRecords(PluginAddress plugin, string cellFormKey, CancellationToken cancel) =>
        _answer.Of(() => Reading(reads => reads.GetCellChildRecords(plugin, cellFormKey), cancel));

    public Answer<IReadOnlyList<InteriorCellBlock>, IndexRefused> GetInteriorCells(PluginAddress plugin, CancellationToken cancel) =>
        _answer.Of(() => WorldspaceTree.InteriorBlocksOf(Reading(reads => reads.GetInteriorCells(plugin), cancel)));

    public Answer<IReadOnlyList<ContainerChildSummary>, IndexRefused> GetContainerChildren(
        PluginAddress plugin, string parentFormKey, CancellationToken cancel) =>
        _answer.Of(() =>
        {
            using var reads = RequireReads(cancel, inOneSnapshot: true);
            return ContainerChildren.Of(reads, plugin, parentFormKey, _loadOrder.Require().GameRelease);
        });

    // A plugin the record index has not reached holds no rows yet and would read clean.
    public Answer<IReadOnlyList<PluginDiagnosisReport>, IndexRefused> GetLoadOrderDiagnoses(CancellationToken cancel) =>
        _answer.Of(() =>
        {
            using var reads = _index.RequireWholeSetReads(cancel);
            return LoadOrderDiagnoses.Of(reads, _loadOrder.Require());
        });

    // A plugin the record index has not opened would read as no dependant.
    public Answer<PluginDependants, IndexRefused> GetDependants(PluginAddress plugin, CancellationToken cancel) =>
        _answer.Of(() =>
        {
            var opened = ReadingWholeSet(reads => reads.OpenedPlugins, cancel);
            return Dependants.Of(plugin, _loadOrder.Require(), opened);
        });

    public Answer<IReadOnlyList<IndexOfPlugin>, IndexRefused> GetPluginsIndexing() =>
        _answer.Of(() => (IReadOnlyList<IndexOfPlugin>)[.. _index.IndexOfPlugins().Select(plugin => plugin with { ChangedOutside = _changedOutside.Holds(new PluginAddress(plugin.Name, plugin.Origin)) })]);

    public Answer<PluginIndexedState, IndexRefused> GetPluginIndexedAsOnDisk(PluginAddress plugin) =>
        _answer.Of(() => _index.IndexedState(plugin));

    // A plugin the record index has not reached holds no record yet, so every link into it would read as a
    // missing record.
    public Answer<IReadOnlyList<PluginProblems>, IndexRefused> GetProblems(PluginAddress? plugin, RecordsAsked? asked, CancellationToken cancel) =>
        _answer.Of(() =>
        {
            using var reads = _index.RequireWholeSetReads(cancel, inOneSnapshot: true);
            return ProblemsPanel.Of(_index, reads, _loadOrder.Require(), source, plugin, asked, cancel);
        });

    public Answer<IReadOnlyList<PluginFilePaths>, IndexRefused> GetFilePaths(PluginAddress? plugin, RecordsAsked? asked, CancellationToken cancel) =>
        _answer.Of(() =>
        {
            using var reads = _index.RequireWholeSetReads(cancel, inOneSnapshot: true);
            return FilePathsPanel.Of(_index, reads, _loadOrder.Require(), source, WhyUnreadable, plugin, asked, cancel);
        });

    public LoadOrderStatus GetStatus() => _index.Status;

    public Task<string?> Hold(IReadOnlyList<HandedPlugin>? written, CancellationToken cancel) => _index.Hold(written, cancel);

    public long GetSequence() => _index.Sequence;

    public async Task<SequenceAwaitResponse> AwaitSequence(long atLeast, TimeSpan timeout)
    {
        var reached = await _index.AwaitSequenceAsync(atLeast, timeout).ConfigureAwait(false);
        return new SequenceAwaitResponse(reached, _index.Sequence);
    }

    public Answer<RecordFilter?, IndexRefused> GetFilter(CancellationToken cancel) =>
        _answer.Of(() => Reading(_ => filter.Current, cancel));

    public IReadOnlyList<PluginAddress> SetChangedOutside(string origin, IReadOnlyList<string> plugins) => _changedOutside.Replace(origin, plugins);

    public FilterCleared? GetFilterCleared() => filter.Cleared;

    public IndexRefused? SetFilter(string sql, string source) => _answer.Refusing(() =>
        filter.Set(_index, sql, source) is { } rejection ? new IndexRefused(IndexRefusal.FilterRejected, rejection) : null);

    public void ClearFilter() => filter.Clear(_index);

    public Answer<SelectedRows, IndexRefused> SelectRows(string sql, CancellationToken cancel) =>
        _answer.Flat(() => SelectedRows.Selected(_index, sql, _answer, cancel));

    public Answer<IReadOnlyList<NamedObject>, IndexRefused> ResolveNames(IReadOnlyList<NameQuery> names, CancellationToken cancel) =>
        _answer.Flat<IReadOnlyList<NamedObject>>(() =>
        {
            using var reads = _index.RequireWholeSetReads(cancel, inOneSnapshot: true);
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

    private RelationReads RequireReads(CancellationToken cancel, bool inOneSnapshot = false) => _index.RequireReads(cancel, inOneSnapshot);

    private T Reading<T>(Func<RelationReads, T> read, CancellationToken cancel)
    {
        using var reads = RequireReads(cancel);
        return read(reads);
    }

    private T ReadingWholeSet<T>(Func<RelationReads, T> read, CancellationToken cancel)
    {
        using var reads = _index.RequireWholeSetReads(cancel);
        return read(reads);
    }

    private IReadOnlyDictionary<string, RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(_loadOrder.Require().GameRelease);

    public void Dispose() => _index.Dispose();
}
