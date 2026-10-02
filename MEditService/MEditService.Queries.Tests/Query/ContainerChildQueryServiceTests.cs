using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

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

        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginAddress plugin, string parentFormKey)
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

        public IReadOnlyDictionary<PluginAddress, PluginContent> OpenedPlugins =>
            new Dictionary<PluginAddress, PluginContent>();
        public RecordDocument? GetDocument(string formKey) => null;
        public RecordDocument? GetDocument(string formKey, PluginAddress plugin) => null;
        public IReadOnlyList<RecordDocument> GetDocuments(PluginAddress plugin) => [];
        public RecordOverrides? GetOverrideStack(string formKey) => null;
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginAddress plugin) => [];
        public RecordLookupEntry? Resolve(string formKey) => null;
        public IReadOnlySet<PluginAddress> GetPluginsWithMatchingRecords(IEnumerable<string> t) => new HashSet<PluginAddress>();
        public IReadOnlySet<string> GetPluginsWithParseFailures() => new HashSet<string>();
        public IReadOnlyList<PluginDiagnosisRow> GetPluginDiagnoses() => [];
        public IReadOnlySet<PluginAddress> GetTrackedPlugins() => new HashSet<PluginAddress>(PluginAddress.Comparer);
        public IReadOnlyList<ReferenceRow> GetReferencedBy(string targetFormKey) => [];
        public IReadOnlyList<string> GetNativeFormKeys(PluginAddress plugin) => [];
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginAddress plugin, string worldspaceFormKey) => [];
        public IReadOnlyList<CellLocationSummary> GetInteriorCells(PluginAddress plugin) => [];
        public IReadOnlySet<string> GetWorldspacesHoldingCells(PluginAddress plugin) => new HashSet<string>();
        public CellChildRecords GetCellChildRecords(PluginAddress plugin, string fk) => new([], []);
        public PlacementRow? GetPlacement(string formKey, PluginAddress plugin) => null;
        public CellLocationRow? GetCellLocation(PluginAddress plugin, string cellFormKey) => null;
        public ContainerChildRow? GetContainerParent(PluginAddress plugin, string childFormKey) => null;
    }

    [Fact]
    public void GetChildren_Quest_KeepsTheIndexsOrder_WhateverTheChildrensTypes()
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
        var svc = new ContainerChildQueryService(new StubIndex(reader));

        var result = svc.GetChildren("M.esp", "qust1:M.esp", "Data");

        Assert.Equal(
            ["dlbr1:M.esp", "dial2:M.esp", "scen1:M.esp", "dial1:M.esp"],
            result.Select(r => r.FormKey).ToArray());
        Assert.Equal(["dlbr", "dial", "scen", "dial"], result.Select(r => r.RecordType).ToArray());
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
        var svc = new ContainerChildQueryService(new StubIndex(reader));

        var result = svc.GetChildren("M.esp", "qust1:M.esp", "Data");

        Assert.True(result.Single(r => r.FormKey == "dial1:M.esp").HasContainerChildren);
        Assert.False(result.Single(r => r.FormKey == "dial2:M.esp").HasContainerChildren);
    }

    [Fact]
    public void GetChildren_DialogTopic_ReturnsItsResponses_TaggedInfo()
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
        var svc = new ContainerChildQueryService(new StubIndex(reader));

        var result = svc.GetChildren("M.esp", "dial1:M.esp", "Data");

        Assert.Equal(["info2:M.esp", "info1:M.esp"], result.Select(r => r.FormKey).ToArray());
        Assert.All(result, r => Assert.Equal("info", r.RecordType));
    }

    [Fact]
    public void GetChildren_PassesGivenOriginToReads()
    {
        var reader = new StubReader([]);
        var svc = new ContainerChildQueryService(new StubIndex(reader));

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
            new StubIndex(reader), loggerFactory.CreateLogger<ContainerChildQueryService>());

        var result = svc.GetChildren("M.esp", "qust1:M.esp", "Data");

        Assert.Equal(["dial1:M.esp"], result.Select(r => r.FormKey).ToArray());
        var warning = Assert.Single(entries, e => e.Level == LogLevel.Warning);
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
        var svc = new ContainerChildQueryService(new StubIndex(reader));

        var result = svc.GetChildren("M.esp", "qust1:M.esp", "Data");

        Assert.Empty(result);
        Assert.Empty(reader.SearchedRecordTypes);
    }

    [Fact]
    public void GetChildren_NoReads_ThrowsNoLoadOrderException()
    {
        var svc = new ContainerChildQueryService(new StubIndex(reads: null));
        Assert.Throws<NoLoadOrderException>(() => svc.GetChildren("M.esp", "qust1:M.esp", "Data"));
    }
}
