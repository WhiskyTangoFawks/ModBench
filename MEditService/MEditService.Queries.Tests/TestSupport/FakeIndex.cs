using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries.Tests.TestSupport;

/// <summary>One active plugin's committed copy of one record, with the facts the index derives
/// beside its document.</summary>
internal sealed record FakeRow(
    RecordDocument Document,
    Index.WorkingTreeState WorkingTreeState = Index.WorkingTreeState.None,
    bool HoldsAnUnreadableRecord = false,
    string? FullName = null)
{
    public PluginAddress Plugin => Document.Plugin;
}

/// <summary>The Index doors Queries drives, answered from <see cref="FakeRow"/> entries instead of
/// a real DuckDB store.</summary>
internal sealed class FakeReads(
    IReadOnlyDictionary<PluginAddress, PluginContent> openedPlugins, IReadOnlyList<FakeRow> rows) : IRecordReads
{
    public IReadOnlyDictionary<string, IReadOnlyList<ReferenceRow>> ReferencedBy { get; set; } =
        new Dictionary<string, IReadOnlyList<ReferenceRow>>(StringComparer.Ordinal);

    public IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins => openedPlugins;

    /// <summary>The filter in force. A fake runs no SQL: <see cref="FilterKeeps"/> is what any
    /// filter's SQL selects here.</summary>
    public (string Sql, string Source)? Filter { get; set; }

    public IReadOnlySet<string> FilterKeeps { get; set; } = new HashSet<string>(StringComparer.Ordinal);

    /// <summary>FormKeys no copy wins until the next sweep: winners stay stale while a reconcile
    /// registers plugins, so a FormKey whose winner was just deactivated has none (ADR-0013).</summary>
    public IReadOnlySet<string> UndecidedWinners { get; set; } = new HashSet<string>(StringComparer.Ordinal);

    // ADR-0013: a FormKey's winner is its copy in the last active plugin. The fake reads every row as
    // an active plugin's, whatever the load order says.
    private bool IsWinner(FakeRow row) => !UndecidedWinners.Contains(row.Document.FormKey) && ReferenceEquals(row, rows
        .Where(r => r.Document.FormKey == row.Document.FormKey)
        .OrderByDescending(r => r.Document.LoadOrderIndex)
        .ThenBy(r => r.Plugin.Name, StringComparer.Ordinal).ThenBy(r => r.Plugin.Origin, StringComparer.Ordinal)
        .First());

    private RecordDocument Read(FakeRow row) => row.Document with { IsWinner = IsWinner(row) };

    public RecordDocument? GetDocument(string formKey) =>
        rows.FirstOrDefault(r => r.Document.FormKey == formKey && IsWinner(r)) is { } row ? Read(row) : null;

    public RecordDocument? GetDocument(string formKey, PluginAddress plugin) =>
        rows.FirstOrDefault(r => r.Document.FormKey == formKey && PluginAddress.Comparer.Equals(r.Plugin, plugin)) is { } row
            ? Read(row)
            : null;

    public RecordDocument? DocumentFromText(string formKey, PluginAddress plugin, int loadOrderIndex, string text) =>
        Resolve(formKey) is { } entry ? RealDocuments.FromText(text, formKey, plugin, loadOrderIndex, entry.RecordType, Resolve) : null;

    public RecordOverrides? GetOverrideStack(string formKey)
    {
        var entries = rows.Where(r => r.Document.FormKey == formKey)
            .OrderBy(r => r.Document.LoadOrderIndex)
            .Select(r => new OverrideStackEntry(
                r.Plugin, r.Document.LoadOrderIndex, IsWinner(r), Read(r), r.WorkingTreeState != Index.WorkingTreeState.None))
            .ToList();
        return entries.Count == 0 ? null : new RecordOverrides(formKey, entries[0].Effective.RecordType, entries);
    }

    public Index.PagedResult<Index.RecordSummary> Search(RecordQuery query)
    {
        var listed = rows.Where(r => Lists(query, r)).ToList();
        var ordered = query.GroupOnly
            ? listed.OrderBy(r => MasterSlot(r.Document.FormKey))
                .ThenBy(r => FormKey.Factory(r.Document.FormKey).ModKey.FileName.String, StringComparer.OrdinalIgnoreCase)
                .ThenBy(r => FormKey.Factory(r.Document.FormKey).ID)
            : listed.OrderBy(r => r.Document.EditorId is null)
                .ThenBy(r => r.Document.EditorId, StringComparer.Ordinal)
                .ThenBy(r => r.Document.FormKey, StringComparer.Ordinal);
        return new(
            [.. ordered.ThenBy(r => r.Plugin.Name, StringComparer.Ordinal).ThenBy(r => r.Plugin.Origin, StringComparer.Ordinal)
                .Skip(query.Offset).Take(query.Limit).Select(Summary)],
            listed.Count);
    }

    private bool Lists(RecordQuery query, FakeRow row)
    {
        var document = row.Document;
        return (query.RecordTypes is not { Count: > 0 } types || types.Contains(document.RecordType, StringComparer.OrdinalIgnoreCase))
            && (query.Plugin is not { } plugin || row.Plugin.Name == plugin.Name)
            && (query.Origin is null || row.Plugin.Origin == query.Origin)
            && (query.Search is not { } search || Matches(search, query.SearchFormKey, document))
            && (query.Scope == RecordQueryScope.Search || Filter is null || FilterKeeps.Contains(document.FormKey))
            && (!query.GroupOnly || !IsHeld(row));
    }

    private static bool Matches(string search, string? searchFormKey, RecordDocument document) =>
        (FormKey.TryFactory(search, out var formKey)
            ? document.FormKey == formKey.ToString()
            : document.EditorId?.Contains(search, StringComparison.OrdinalIgnoreCase) == true)
        || document.FormKey == searchFormKey;

    private bool IsHeld(FakeRow row) => ContainerChildren.Any(holding =>
        PluginAddress.Comparer.Equals(holding.Key.Plugin, row.Plugin) && holding.Value.Any(c => c.ChildFormKey == row.Document.FormKey));

    // A FormID's load index is its filename's, a light plugin's following every full plugin's; a
    // filename no plugin here holds sorts last.
    private (bool IsLight, int Slot) MasterSlot(string formKey)
    {
        var file = FormKey.Factory(formKey).ModKey.FileName.String;
        return rows.Where(r => string.Equals(r.Plugin.Name, file, StringComparison.OrdinalIgnoreCase))
            .Select(r => (openedPlugins.TryGetValue(r.Plugin, out var content) && content.IsLight, r.Document.LoadOrderIndex))
            .DefaultIfEmpty((true, int.MaxValue))
            .Min();
    }

    private Index.RecordSummary Summary(FakeRow row) => new(
        row.Document.FormKey, row.Plugin.Name, row.Document.LoadOrderIndex, IsWinner(row), row.Document.EditorId, row.Plugin.Origin,
        row.WorkingTreeState, HasContainerChildren: GetContainerChildren(row.Plugin, row.Document.FormKey).Count > 0,
        row.Document.ParseDiagnosis, HasParseFailure: row.Document.ParseDiagnosis is not null || row.HoldsAnUnreadableRecord,
        row.FullName);

    // The grouping and counting are the real Index's own behaviour; keyed so a test can
    // configure one plugin's counts without touching another's.
    public IReadOnlyDictionary<PluginAddress, IReadOnlyList<RecordTypeCount>> RecordTypeCountsByPlugin { get; set; } =
        new Dictionary<PluginAddress, IReadOnlyList<RecordTypeCount>>();

    public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginAddress plugin) =>
        RecordTypeCountsByPlugin.GetValueOrDefault(plugin, []);

    public IReadOnlyDictionary<string, RecordLookupEntry>? Lookups { get; init; }

    public RecordLookupEntry? Resolve(string formKey) =>
        Lookups is not null && Lookups.TryGetValue(formKey, out var entry) ? entry :
        GetDocument(formKey) is { } winner ? new(winner.RecordType, winner.EditorId) : null;

    public IReadOnlyList<ReferenceRow> GetReferencedBy(string targetFormKey) =>
        ReferencedBy.GetValueOrDefault(targetFormKey, []);

    public IReadOnlyList<MissingReferenceOnFile> MissingReferences { get; set; } = [];

    public IReadOnlyList<MissingReferenceOnFile> GetReferencesToMissingRecordsOnFiles(Func<PluginAddress, PluginProvider.FromMod?> modOf) =>
        MissingReferences;

    public IReadOnlySet<PluginAddress> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) =>
        Filter is null
            ? new HashSet<PluginAddress>(PluginAddress.Comparer)
            : rows.Where(r => FilterKeeps.Contains(r.Document.FormKey) && tableNames.Contains(r.Document.RecordType, StringComparer.OrdinalIgnoreCase))
                .Select(r => r.Plugin).ToHashSet(PluginAddress.Comparer);

    public IReadOnlySet<string> GetPluginsWithParseFailures() =>
        rows.Where(r => r.Document.ParseDiagnosis != null).Select(r => ColumnKey.Of(r.Plugin.Name, r.Plugin.Origin))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    // Projecting a diagnosis and deciding which plugins were derived from a source tree are the real
    // Index's own behaviour; a test states the rows it wants read back.
    public IReadOnlyList<PluginDiagnosisRow> Diagnoses { get; set; } = [];

    public IReadOnlyDictionary<PluginAddress, DerivedFrom> Derivations { get; set; } =
        new Dictionary<PluginAddress, DerivedFrom>(PluginAddress.Comparer);

    public IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses() => Diagnoses;
    public IReadOnlyDictionary<PluginAddress, DerivedFrom> GetDerivations() => Derivations;

    // The worldspace tree's and the containers' rows, each read from the plugin that holds them.
    public IReadOnlyDictionary<RecordAt, IReadOnlyList<CellLocationSummary>> WorldspaceCells { get; set; } =
        new Dictionary<RecordAt, IReadOnlyList<CellLocationSummary>>();
    public IReadOnlyDictionary<PluginAddress, IReadOnlyList<CellLocationSummary>> InteriorCells { get; set; } =
        new Dictionary<PluginAddress, IReadOnlyList<CellLocationSummary>>();
    public IReadOnlyDictionary<RecordAt, Index.CellChildRecords> CellChildren { get; set; } =
        new Dictionary<RecordAt, Index.CellChildRecords>();
    public IReadOnlyDictionary<RecordAt, IReadOnlyList<ContainerChildRow>> ContainerChildren { get; set; } =
        new Dictionary<RecordAt, IReadOnlyList<ContainerChildRow>>();

    public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginAddress plugin, string worldspaceFormKey) =>
        WorldspaceCells.GetValueOrDefault(new RecordAt(plugin, worldspaceFormKey), []);
    public IReadOnlyList<CellLocationSummary> GetInteriorCells(PluginAddress plugin) => InteriorCells.GetValueOrDefault(plugin, []);
    public IReadOnlySet<string> GetWorldspacesHoldingCells(PluginAddress plugin) =>
        WorldspaceCells.Where(w => PluginAddress.Comparer.Equals(w.Key.Plugin, plugin) && w.Value.Count > 0).Select(w => w.Key.FormKey).ToHashSet();
    public Index.CellChildRecords GetCellChildRecords(PluginAddress plugin, string cellFormKey) =>
        CellChildren.GetValueOrDefault(new RecordAt(plugin, cellFormKey), new([], []));
    public IReadOnlyDictionary<RecordAt, CellLocationRow> CellLocations { get; set; } = new Dictionary<RecordAt, CellLocationRow>();
    public CellLocationRow? GetCellLocation(PluginAddress plugin, string cellFormKey) =>
        CellLocations.TryGetValue(new RecordAt(plugin, cellFormKey), out var location) ? location : null;
    public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginAddress plugin, string parentFormKey) =>
        ContainerChildren.GetValueOrDefault(new RecordAt(plugin, parentFormKey), []);
    public IReadOnlySet<RecordAt> RecordsWithChildren { get; set; } = new HashSet<RecordAt>();
    public IReadOnlySet<PluginAddress> ChildHolders { get; set; } = new HashSet<PluginAddress>(PluginAddress.Comparer);
    public bool HasChildRecords(PluginAddress plugin, string formKey) => RecordsWithChildren.Contains(new RecordAt(plugin, formKey));
    public IReadOnlySet<PluginAddress> PluginsHoldingChildRecords(PluginAddress plugin, string formKey) => ChildHolders;
}

/// <summary>The IQueryIndex door over a FakeReads: a settable status and sequence, since a hand
/// double states what it needs rather than computing it.</summary>
internal sealed class FakeIndex(FakeReads reads, LoadOrderStatus? status = null) : IQueryIndex
{
    public LoadOrderStatus Status { get; set; } = status ?? new LoadOrderStatus(LoadOrderState.Ready, reads.OpenedPlugins.Count, reads.OpenedPlugins.Count, [], true, []);
    public (string Sql, string Source)? ActiveFilter => reads.Filter;
    public long Sequence { get; set; }
    public (GameRelease Release, string InstanceRoot)? Rebuilt { get; private set; }
    public IRecordReads RequireReads() => reads;

    public IReadOnlyList<SourceFileFailure> SourceFileFailures { get; set; } = [];

    public Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout) => Task.FromResult(Sequence >= atLeast);

    public void SetFilter(string sql, string source) => reads.Filter = (sql, source);

    public void ClearFilter() => reads.Filter = null;

    public string? RefusalToRebuild { get; set; }

    public StoreRebuild RebuildStore(GameRelease gameRelease, string instanceRoot)
    {
        if (RefusalToRebuild is null) Rebuilt = (gameRelease, instanceRoot);
        return new StoreRebuild(Task.CompletedTask, RefusalToRebuild);
    }

    /// <summary>A whole fixture, opened: the index and the load order it was built against.</summary>
    internal static (FakeIndex Index, LoadOrderHolder Holder) From(FakeFixtureData fixture)
    {
        var holder = FakeLoadOrder.Of(fixture.Release, [.. fixture.Plugins]);
        return (new FakeIndex(new FakeReads(fixture.OpenedPlugins, fixture.Rows)), holder);
    }
}

/// <summary>The Index over any reads, never projected and unfiltered. The reads' presence is what
/// "no load order" means for the Index side.</summary>
internal sealed class StubIndex(IRecordReads? reads) : IQueryIndex
{
    public LoadOrderStatus Status => LoadOrderStatus.None;
    public (string Sql, string Source)? ActiveFilter => null;
    public long Sequence => 0;
    public IRecordReads RequireReads() => reads ?? throw new NoLoadOrderException();

    public IReadOnlyList<SourceFileFailure> SourceFileFailures => [];

    public Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout) => throw ReadsOnly();
    public void SetFilter(string sql, string source) => throw ReadsOnly();
    public void ClearFilter() => throw ReadsOnly();
    public StoreRebuild RebuildStore(GameRelease gameRelease, string instanceRoot) => throw ReadsOnly();

    private NotSupportedException ReadsOnly() => new($"{GetType().Name} answers reads only.");
}
