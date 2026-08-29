using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Session;
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

        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginKey plugin, string parentFormKey)
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

        public RecordDocument? GetDocument(string formKey) => null;
        public RecordDocument? GetDocument(string formKey, PluginKey plugin) => null;
        public IReadOnlyList<RecordDocument> GetDocuments(PluginKey plugin) => [];
        public RecordOverrides? GetOverrideStack(string formKey) => null;
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginKey plugin) => [];
        public IReadOnlyList<string> GetContestedFormKeys() => [];
        public RecordLookupEntry? Resolve(string formKey) => null;
        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> t) => new HashSet<string>();
        public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) => [];
        public IReadOnlyList<string> GetNativeFormKeys(PluginKey plugin) => [];
        public IReadOnlyList<string> GetEffectiveMasters(PluginKey plugin) => [];
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginKey plugin, string worldspaceFormKey) => [];
        public PagedResult<CellSummary> GetInteriorCells(PluginKey plugin, int l, int o) => new([], 0);
        public CellReferences GetCellReferences(PluginKey plugin, string fk) => new([], []);
        public PlacementRow? GetPlacement(string formKey, PluginKey plugin) => null;
        public CellLocationRow? GetCellLocation(PluginKey plugin, string cellFormKey) => null;
        public ContainerChildRow? GetContainerParent(PluginKey plugin, string childFormKey) => null;
    }

    private sealed class StubSession(IRecordReads repo, IGameSession? session = null) : ISessionManager
    {
        public IGameSession? Session => session;
        public IRecordReads? Repository => repo;
        public IRecordIndex? Index => null;
        public SessionStatus Status => SessionStatus.None;
        public void Load(string d, string p, GameRelease g) => throw new NotSupportedException();
        public void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease) => throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string n, string p, string o) => throw new NotSupportedException();
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => throw new NotSupportedException();
        public void UnloadUnlistedPlugin(string plugin, string origin) => throw new NotSupportedException();
        public PluginResponse RereadPlugin(string plugin, string newPath, string newOrigin) => throw new NotSupportedException();
        public PluginResponse SetPluginParticipation(string plugin, bool participates) => throw new NotSupportedException();
        public Task ReindexPlugin(string p) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> p) => throw new NotSupportedException();
        public void SetFilter(string s) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
        public void ReapplyFilter() => throw new NotSupportedException();
    }

    private sealed class StubGameSession(IReadOnlyList<PluginMetadata> plugins) : IGameSession
    {
        public string DataFolderPath => "";
        public GameRelease GameRelease => GameRelease.Fallout4;
        public IReadOnlyList<PluginMetadata> Plugins => plugins;
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string? FilterSql { get; set; }
        public Mutagen.Bethesda.Plugins.Records.IModGetter? GetMod(string pluginName, string origin) => null;
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex) => throw new NotSupportedException();
        public bool RemoveUnlistedPlugin(string pluginName, string origin) => throw new NotSupportedException();
        public void Dispose() { }
    }

    // Slice 1: mixed DialogTopics/DialogBranches/Scenes rows come back Topics, then Branches, then
    // Scenes (xEdit's own DIAL, DLBR, SCEN order) — never the raw table's alphabetical
    // "DialogBranches, DialogTopics, Scenes" ORDER BY. A naive pass-through of
    // IRecordReads.GetContainerChildren's own row order would fail this: it would put the branch
    // before either topic.
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
        var svc = new ContainerChildQueryService(new StubSession(reader));

        var result = svc.GetChildren("M.esp", "qust1:M.esp");

        Assert.Equal(
            ["dial1:M.esp", "dial2:M.esp", "dlbr1:M.esp", "scen1:M.esp"],
            result.Select(r => r.FormKey).ToArray());
        Assert.Equal(["dial", "dial", "dlbr", "scen"], result.Select(r => r.RecordType).ToArray());
    }

    // Slice 2: a Dialog Topic's Responses come back in SlotIndex order, tagged "info".
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
        var svc = new ContainerChildQueryService(new StubSession(reader));

        var result = svc.GetChildren("M.esp", "dial1:M.esp");

        Assert.Equal(["info1:M.esp", "info2:M.esp"], result.Select(r => r.FormKey).ToArray());
        Assert.All(result, r => Assert.Equal("info", r.RecordType));
    }

    // Slice 3: explicit origin overrides load-order resolution, the same shape every other
    // spatial-tree read already has (#305 / ADR-0036).
    [Fact]
    public void GetChildren_ExplicitOrigin_OverridesResolvedOrigin()
    {
        var reader = new StubReader([]);
        var session = new StubGameSession([
            new PluginMetadata("M.esp", "", 0, false, false, [], 0, false, Origin: "ModA"),
        ]);
        var svc = new ContainerChildQueryService(new StubSession(reader, session));

        svc.GetChildren("M.esp", "qust1:M.esp", origin: "ModB");

        Assert.Equal("ModB", reader.LastGetContainerChildrenOrigin);
    }

    // Slice 4: a container_child row naming a child FormKey Search doesn't return is an index
    // inconsistency between two tables written from the same ingest pass — never expected in
    // practice, but GetChildren degrades by omission (skips just that row, keeps the survivors)
    // rather than throwing, and logs a warning naming every identifying fact. Rival: an
    // unconditional dictionary index (`byFormKey[row.ChildFormKey]` instead of TryGetValue) would
    // throw KeyNotFoundException here instead of returning dial1 alone.
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
        var svc = new ContainerChildQueryService(new StubSession(reader), loggerFactory.CreateLogger<ContainerChildQueryService>());

        var result = svc.GetChildren("M.esp", "qust1:M.esp");

        Assert.Equal(["dial1:M.esp"], result.Select(r => r.FormKey).ToArray());
        var warning = Assert.Single(entries, e => e.Level == LogLevel.Warning);
        // Origin is omitted here (no session), so PluginOriginResolver resolves it to the
        // reserved PluginOrigin.DataDirectory value ("Data") — the same fallback every other
        // caller of that resolver gets.
        Assert.Equal(
            "Container child dial-missing:M.esp of qust1:M.esp in M.esp (Data) is indexed in " +
            "container_child but Search(dial) did not return it; omitting.",
            warning.Message);
    }

    // Slice 5: no rows at all (a Quest with no topics/branches/scenes) is an empty list, not an
    // error, and issues no Search calls.
    [Fact]
    public void GetChildren_NoContainerChildRows_ReturnsEmpty_WithoutSearching()
    {
        var reader = new StubReader([]);
        var svc = new ContainerChildQueryService(new StubSession(reader));

        var result = svc.GetChildren("M.esp", "qust1:M.esp");

        Assert.Empty(result);
        Assert.Empty(reader.SearchedRecordTypes);
    }

    [Fact]
    public void GetChildren_NoSession_ThrowsInvalidOperation()
    {
        var svc = new ContainerChildQueryService(new StubSession(null!));
        Assert.Throws<InvalidOperationException>(() => svc.GetChildren("M.esp", "qust1:M.esp"));
    }
}
