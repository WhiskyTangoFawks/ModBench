using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public class ContainerChildQueryServiceTests
{
    private sealed class StubReader(
        IReadOnlyList<ContainerChildRow> containerChildren,
        IReadOnlyDictionary<string, IReadOnlyList<Index.RecordSummary>>? searchByType = null) : IRecordReads
    {
        public string? LastGetContainerChildrenOrigin { get; private set; }
        public readonly List<string?> SearchedRecordTypes = [];

        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginAddress plugin, string parentFormKey)
        {
            LastGetContainerChildrenOrigin = plugin.Origin;
            return containerChildren;
        }

        public Index.PagedResult<Index.RecordSummary> Search(RecordQuery query)
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
        public Index.CellChildRecords GetCellChildRecords(PluginAddress plugin, string fk) => new([], []);
        public PlacementRow? GetPlacement(string formKey, PluginAddress plugin) => null;
        public CellLocationRow? GetCellLocation(PluginAddress plugin, string cellFormKey) => null;
        public ContainerChildRow? GetContainerParent(PluginAddress plugin, string childFormKey) => null;
        public bool HasChildRecords(PluginAddress plugin, string formKey) => false;
        public IReadOnlySet<PluginAddress> PluginsHoldingChildRecords(PluginAddress plugin, string formKey) => new HashSet<PluginAddress>();
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
            new Dictionary<string, IReadOnlyList<Index.RecordSummary>>
            {
                ["dial"] =
                [
                    new Index.RecordSummary("dial1:M.esp", "M.esp", 0, true, "TopicA", "Data"),
                    new Index.RecordSummary("dial2:M.esp", "M.esp", 0, true, "TopicB", "Data"),
                ],
                ["dlbr"] = [new Index.RecordSummary("dlbr1:M.esp", "M.esp", 0, true, "BranchA", "Data")],
                ["scen"] = [new Index.RecordSummary("scen1:M.esp", "M.esp", 0, true, "SceneA", "Data")],
            });
        var svc = new ContainerChildQueryService(new StubIndex(reader));

        var result = svc.GetChildren(new PluginAddress("M.esp", "Data"), "qust1:M.esp");

        Assert.Equal(
            ["dlbr1:M.esp", "dial2:M.esp", "scen1:M.esp", "dial1:M.esp"],
            result.Select(r => r.FormKey).ToArray());
        Assert.Equal(["dlbr", "dial", "scen", "dial"], result.Select(r => r.RecordType).ToArray());
    }

    [Fact]
    public void GetChildren_HydratesHasContainerChildren_FromRecordSummary_ForADialChildIsItselfAContainerThePluginsTreeExpands()
    {
        var reader = new StubReader(
            [
                new ContainerChildRow("dial1:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 0),
                new ContainerChildRow("dial2:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 1),
            ],
            new Dictionary<string, IReadOnlyList<Index.RecordSummary>>
            {
                ["dial"] =
                [
                    new Index.RecordSummary("dial1:M.esp", "M.esp", 0, true, "TopicA", "Data", HasContainerChildren: true),
                    new Index.RecordSummary("dial2:M.esp", "M.esp", 0, true, "TopicB", "Data", HasContainerChildren: false),
                ],
            });
        var svc = new ContainerChildQueryService(new StubIndex(reader));

        var result = svc.GetChildren(new PluginAddress("M.esp", "Data"), "qust1:M.esp");

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
            new Dictionary<string, IReadOnlyList<Index.RecordSummary>>
            {
                ["info"] =
                [
                    new Index.RecordSummary("info1:M.esp", "M.esp", 0, true, null, "Data"),
                    new Index.RecordSummary("info2:M.esp", "M.esp", 0, true, null, "Data"),
                ],
            });
        var svc = new ContainerChildQueryService(new StubIndex(reader));

        var result = svc.GetChildren(new PluginAddress("M.esp", "Data"), "dial1:M.esp");

        Assert.Equal(["info2:M.esp", "info1:M.esp"], result.Select(r => r.FormKey).ToArray());
        Assert.All(result, r => Assert.Equal("info", r.RecordType));
    }

    [Fact]
    public void GetChildren_PassesGivenOriginToReads()
    {
        var reader = new StubReader([]);
        var svc = new ContainerChildQueryService(new StubIndex(reader));

        svc.GetChildren(new PluginAddress("M.esp", "ModB"), "qust1:M.esp");

        Assert.Equal("ModB", reader.LastGetContainerChildrenOrigin);
    }

    [Fact]
    public void GetChildren_ContainerChildRowSearchDidNotReturn_SkipsItInsteadOfThrowingKeyNotFound_ReturnsSurvivors_LogsWarning()
    {
        var reader = new StubReader(
            [
                new ContainerChildRow("dial1:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 0),
                new ContainerChildRow("dial-missing:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 1),
            ],
            new Dictionary<string, IReadOnlyList<Index.RecordSummary>>
            {
                ["dial"] = [new Index.RecordSummary("dial1:M.esp", "M.esp", 0, true, "TopicA", "Data")],
            });
        var entries = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(entries)));
        var svc = new ContainerChildQueryService(
            new StubIndex(reader), loggerFactory.CreateLogger<ContainerChildQueryService>());

        var result = svc.GetChildren(new PluginAddress("M.esp", "Data"), "qust1:M.esp");

        Assert.Equal(["dial1:M.esp"], result.Select(r => r.FormKey).ToArray());
        var warning = Assert.Single(entries, e => e.Level == LogLevel.Warning);
        Assert.Equal(
            "Container child dial-missing:M.esp of qust1:M.esp in M.esp (Data) is indexed in " +
            "container_child but Search(dial) did not return it; omitting.",
            warning.Message);
    }

    [Fact]
    public void GetChildren_NoContainerChildRows_ReturnsEmpty_WithoutSearching()
    {
        var reader = new StubReader([]);
        var svc = new ContainerChildQueryService(new StubIndex(reader));

        var result = svc.GetChildren(new PluginAddress("M.esp", "Data"), "qust1:M.esp");

        Assert.Empty(result);
        Assert.Empty(reader.SearchedRecordTypes);
    }

    [Fact]
    public void GetChildren_NoReads_ThrowsNoLoadOrderException()
    {
        var svc = new ContainerChildQueryService(new StubIndex(reads: null));
        Assert.Throws<NoLoadOrderException>(() => svc.GetChildren(new PluginAddress("M.esp", "Data"), "qust1:M.esp"));
    }
}
