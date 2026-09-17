using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Query;

public class ContainerChildQueryServiceTests
{
    // A repository stub returning fixed container_child rows plus a per-record-type Search
    // fixture — exercises the service's re-ordering and hydration logic without DuckDB.
    private sealed class StubReader(
        IReadOnlyList<ContainerChildRow> containerChildren,
        IReadOnlyDictionary<string, IReadOnlyList<RecordSummary>>? searchByType = null) : IRecordReads
    {
        public string? LastGetContainerChildrenOrigin { get; private set; }
        public readonly List<string?> SearchedRecordTypes = [];

        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginCopyKey plugin, string parentFormKey)
        {
            LastGetContainerChildrenOrigin = plugin.Origin;
            return containerChildren;
        }

        public PagedResult<RecordSummary> Search(RecordQuery query)
        {
            var type = query.RecordTypes?.SingleOrDefault();
            SearchedRecordTypes.Add(type);
            var items = type != null && searchByType != null && searchByType.TryGetValue(type, out var found)
                ? found
                : [];
            return new(items, items.Count);
        }

        public IReadOnlyDictionary<PluginCopyKey, PluginContent> OpenedCopies =>
            new Dictionary<PluginCopyKey, PluginContent>();
        public RecordDocument? GetDocument(string formKey) => null;
        public RecordDocument? GetDocument(string formKey, PluginCopyKey plugin) => null;
        public IReadOnlyList<RecordDocument> GetDocuments(PluginCopyKey plugin) => [];
        public RecordOverrides? GetOverrideStack(string formKey) => null;
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginCopyKey plugin) => [];
        public RecordLookupEntry? Resolve(string formKey) => null;
        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> t) => new HashSet<string>();
        public IReadOnlySet<string> GetPluginsWithParseFailures() => new HashSet<string>();
        public IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses() => [];
        public IReadOnlySet<PluginCopyKey> GetTrackedCopies() => new HashSet<PluginCopyKey>(PluginCopyKey.Comparer);
        public IReadOnlySet<string> GetWorldspacesWithFailuresBelow(PluginCopyKey p) => new HashSet<string>();
        public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) => [];
        public IReadOnlyList<string> GetNativeFormKeys(PluginCopyKey plugin) => [];
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginCopyKey plugin, string worldspaceFormKey) => [];
        public PagedResult<CellSummary> GetInteriorCells(PluginCopyKey plugin, int l, int o) => new([], 0);
        public CellReferences GetCellReferences(PluginCopyKey plugin, string fk) => new([], []);
        public PlacementRow? GetPlacement(string formKey, PluginCopyKey plugin) => null;
        public CellLocationRow? GetCellLocation(PluginCopyKey plugin, string cellFormKey) => null;
        public ContainerChildRow? GetContainerParent(PluginCopyKey plugin, string childFormKey) => null;
    }

    // The reads' presence is what "no load order" means for the Index side; this service takes
    // the load order itself from the holder.
    private sealed class StubIndex(IRecordReads reads) : IQueryIndex
    {
        // These stubs never project, so they are always in the no-load-order state and unfiltered.
        public LoadOrderStatus Status => LoadOrderStatus.None;
        public string? FilterSql => null;
        public IRecordReads RequireReads() => reads ?? throw new NoLoadOrderException();
    }

    private static LoadOrderHolder Holder(params RegisteredCopy[] copies)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(new LoadOrderSnapshot(@"C:\Games\Fallout4\Data", null, GameRelease.Fallout4, copies));
        return holder;
    }

    private static RegisteredCopy Copy(string name, string origin) =>
        new(name, origin, Path.Combine(@"C:\MO2\mods", origin, name), Slot: 0, Enabled: true, Winning: true);

    // Mixed rows come back Topics, then Branches, then Scenes (xEdit's DIAL, DLBR, SCEN order), never
    // the raw table's alphabetical ORDER BY, which would put the branch before either topic.
    [Fact]
    public void GetChildren_Quest_OrdersTopicsThenBranchesThenScenes()
    {
        var reader = new StubReader(
            [
                new ContainerChildRow("dlbr1:M.esp", "qust1:M.esp", "Quest", "DialogBranches", 0),
                new ContainerChildRow("dial2:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 1),
                new ContainerChildRow("scen1:M.esp", "qust1:M.esp", "Quest", "Scenes", 0),
                new ContainerChildRow("dial1:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 0),
            ],
            new Dictionary<string, IReadOnlyList<RecordSummary>>
            {
                ["dial"] =
                [
                    new RecordSummary("dial1:M.esp", "M.esp", 0, true, "TopicA", "Data"),
                    new RecordSummary("dial2:M.esp", "M.esp", 0, true, "TopicB", "Data"),
                ],
                ["dlbr"] = [new RecordSummary("dlbr1:M.esp", "M.esp", 0, true, "BranchA", "Data")],
                ["scen"] = [new RecordSummary("scen1:M.esp", "M.esp", 0, true, "SceneA", "Data")],
            });
        var svc = new ContainerChildQueryService(new StubIndex(reader), Holder());

        var result = svc.GetChildren("M.esp", "qust1:M.esp");

        Assert.Equal(
            ["dial1:M.esp", "dial2:M.esp", "dlbr1:M.esp", "scen1:M.esp"],
            result.Select(r => r.FormKey).ToArray());
        Assert.Equal(["dial", "dial", "dlbr", "scen"], result.Select(r => r.RecordType).ToArray());
    }

    // A returned "dial" child is itself a container the Plugins tree can expand, so its
    // HasContainerChildren flag must survive the flattening this service does. A constructor call
    // dropping it would pass every other assertion here, since none look at it.
    [Fact]
    public void GetChildren_HydratesHasContainerChildren_FromRecordSummary()
    {
        var reader = new StubReader(
            [
                new ContainerChildRow("dial1:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 0),
                new ContainerChildRow("dial2:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 1),
            ],
            new Dictionary<string, IReadOnlyList<RecordSummary>>
            {
                ["dial"] =
                [
                    new RecordSummary("dial1:M.esp", "M.esp", 0, true, "TopicA", "Data", HasContainerChildren: true),
                    new RecordSummary("dial2:M.esp", "M.esp", 0, true, "TopicB", "Data", HasContainerChildren: false),
                ],
            });
        var svc = new ContainerChildQueryService(new StubIndex(reader), Holder());

        var result = svc.GetChildren("M.esp", "qust1:M.esp");

        Assert.True(result.Single(r => r.FormKey == "dial1:M.esp").HasContainerChildren);
        Assert.False(result.Single(r => r.FormKey == "dial2:M.esp").HasContainerChildren);
    }

    // A Dialog Topic's Responses come back in SlotIndex order, tagged "info".
    [Fact]
    public void GetChildren_DialogTopic_ReturnsResponsesInSlotOrder_TaggedInfo()
    {
        var reader = new StubReader(
            [
                new ContainerChildRow("info2:M.esp", "dial1:M.esp", "DialogTopic", "Responses", 1),
                new ContainerChildRow("info1:M.esp", "dial1:M.esp", "DialogTopic", "Responses", 0),
            ],
            new Dictionary<string, IReadOnlyList<RecordSummary>>
            {
                ["info"] =
                [
                    new RecordSummary("info1:M.esp", "M.esp", 0, true, null, "Data"),
                    new RecordSummary("info2:M.esp", "M.esp", 0, true, null, "Data"),
                ],
            });
        var svc = new ContainerChildQueryService(new StubIndex(reader), Holder());

        var result = svc.GetChildren("M.esp", "dial1:M.esp");

        Assert.Equal(["info1:M.esp", "info2:M.esp"], result.Select(r => r.FormKey).ToArray());
        Assert.All(result, r => Assert.Equal("info", r.RecordType));
    }

    // Explicit origin overrides load-order resolution, the same shape every other
    // spatial-tree read already has (ADR-0012).
    [Fact]
    public void GetChildren_ExplicitOrigin_OverridesResolvedOrigin()
    {
        var reader = new StubReader([]);
        var svc = new ContainerChildQueryService(new StubIndex(reader), Holder(Copy("M.esp", "ModA")));

        svc.GetChildren("M.esp", "qust1:M.esp", origin: "ModB");

        Assert.Equal("ModB", reader.LastGetContainerChildrenOrigin);
    }

    // A container_child row naming a child Search does not return is an index inconsistency between
    // two tables written from one ingest pass. GetChildren degrades by omission rather than throwing;
    // an unconditional dictionary index would throw KeyNotFoundException here.
    [Fact]
    public void GetChildren_ContainerChildRowSearchDidNotReturn_SkipsIt_ReturnsSurvivors_LogsWarning()
    {
        var reader = new StubReader(
            [
                new ContainerChildRow("dial1:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 0),
                new ContainerChildRow("dial-missing:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 1),
            ],
            new Dictionary<string, IReadOnlyList<RecordSummary>>
            {
                // Search("dial") never returns dial-missing:M.esp — the index-inconsistency case.
                ["dial"] = [new RecordSummary("dial1:M.esp", "M.esp", 0, true, "TopicA", "Data")],
            });
        var entries = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(entries)));
        var svc = new ContainerChildQueryService(
            new StubIndex(reader), Holder(), loggerFactory.CreateLogger<ContainerChildQueryService>());

        var result = svc.GetChildren("M.esp", "qust1:M.esp");

        Assert.Equal(["dial1:M.esp"], result.Select(r => r.FormKey).ToArray());
        var warning = Assert.Single(entries, e => e.Level == LogLevel.Warning);
        // Origin is omitted here (no copy of that name), so PluginOriginResolver resolves it to the
        // reserved PluginOrigin.DataDirectory value ("Data") — the same fallback every other
        // caller of that resolver gets.
        Assert.Equal(
            "Container child dial-missing:M.esp of qust1:M.esp in M.esp (Data) is indexed in " +
            "container_child but Search(dial) did not return it; omitting.",
            warning.Message);
    }

    // No rows at all (a Quest with no topics/branches/scenes) is an empty list, not an
    // error, and issues no Search calls.
    [Fact]
    public void GetChildren_NoContainerChildRows_ReturnsEmpty_WithoutSearching()
    {
        var reader = new StubReader([]);
        var svc = new ContainerChildQueryService(new StubIndex(reader), Holder());

        var result = svc.GetChildren("M.esp", "qust1:M.esp");

        Assert.Empty(result);
        Assert.Empty(reader.SearchedRecordTypes);
    }

    [Fact]
    public void GetChildren_NoLoadOrder_ThrowsInvalidOperation()
    {
        // The reads are there; what is missing is a snapshot in the kernel.
        var svc = new ContainerChildQueryService(new StubIndex(new StubReader([])), new LoadOrderHolder());
        Assert.Throws<NoLoadOrderException>(() => svc.GetChildren("M.esp", "qust1:M.esp"));
    }
}
