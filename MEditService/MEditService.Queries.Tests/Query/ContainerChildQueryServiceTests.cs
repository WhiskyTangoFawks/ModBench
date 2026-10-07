using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public class ContainerChildQueryServiceTests
{
    private static readonly LoadOrderHolder Fallout4 = FakeLoadOrder.Of(GameRelease.Fallout4);

    private static readonly PluginAddress Plugin = new("M.esp", "Data");

    private static ContainerChildQueryService Service(
        IReadOnlyList<ContainerChildRow> children, IReadOnlyList<FakeRow> records, ILoggerFactory? loggerFactory = null)
    {
        var reads = new FakeReads(new Dictionary<PluginAddress, PluginContent>(), records)
        {
            ContainerChildren = children.GroupBy(c => c.ParentFormKey)
                .ToDictionary(g => new RecordAt(Plugin, g.Key), g => (IReadOnlyList<ContainerChildRow>)[.. g]),
        };
        return QueryHost.Containers(new StubIndex(reads), Fallout4, loggerFactory);
    }

    private static FakeRow Record(string formKey, string recordType, string? editorId = null, PluginAddress? plugin = null) =>
        new(new RecordDocument(formKey, plugin ?? Plugin, 0, IsWinner: false, editorId, recordType, null, []));

    [Fact]
    public void GetChildren_Quest_KeepsTheIndexsOrder_WhateverTheChildrensTypes()
    {
        var svc = Service(
            [
                new ContainerChildRow("dlbr1:M.esp", "qust1:M.esp", "Quest", "DialogBranches", 0),
                new ContainerChildRow("dial2:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 1),
                new ContainerChildRow("scen1:M.esp", "qust1:M.esp", "Quest", "Scenes", 0),
                new ContainerChildRow("dial1:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 0),
            ],
            [
                Record("dial1:M.esp", "dial", "TopicA"),
                Record("dial2:M.esp", "dial", "TopicB"),
                Record("dlbr1:M.esp", "dlbr", "BranchA"),
                Record("scen1:M.esp", "scen", "SceneA"),
            ]);

        var result = svc.GetChildren(Plugin, "qust1:M.esp");

        Assert.Equal(
            ["dlbr1:M.esp", "dial2:M.esp", "scen1:M.esp", "dial1:M.esp"],
            result.Select(r => r.FormKey).ToArray());
        Assert.Equal(["dlbr", "dial", "scen", "dial"], result.Select(r => r.RecordType).ToArray());
    }

    [Fact]
    public void GetChildren_SaysWhichChildHoldsChildrenOfItsOwn_ForADialChildIsItselfAContainerThePluginsTreeExpands()
    {
        var svc = Service(
            [
                new ContainerChildRow("dial1:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 0),
                new ContainerChildRow("dial2:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 1),
                new ContainerChildRow("info1:M.esp", "dial1:M.esp", "DialogTopic", "Responses", 0),
            ],
            [Record("dial1:M.esp", "dial", "TopicA"), Record("dial2:M.esp", "dial", "TopicB"), Record("info1:M.esp", "info")]);

        var result = svc.GetChildren(Plugin, "qust1:M.esp");

        Assert.True(result.Single(r => r.FormKey == "dial1:M.esp").HasContainerChildren);
        Assert.False(result.Single(r => r.FormKey == "dial2:M.esp").HasContainerChildren);
    }

    [Fact]
    public void GetChildren_SaysWhichChildIsAContainer_AnEmptyTopicIncluded()
    {
        var svc = Service(
            [
                new ContainerChildRow("dial1:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 0),
                new ContainerChildRow("dlbr1:M.esp", "qust1:M.esp", "Quest", "DialogBranches", 0),
            ],
            [Record("dial1:M.esp", "dial", "Topic"), Record("dlbr1:M.esp", "dlbr", "Branch")]);

        var result = svc.GetChildren(Plugin, "qust1:M.esp");

        Assert.True(result.Single(r => r.FormKey == "dial1:M.esp").IsContainer);
        Assert.False(result.Single(r => r.FormKey == "dlbr1:M.esp").IsContainer);
    }

    [Fact]
    public void GetChildren_DialogTopic_ReturnsItsResponses_TaggedInfo()
    {
        var svc = Service(
            [
                new ContainerChildRow("info2:M.esp", "dial1:M.esp", "DialogTopic", "Responses", 1),
                new ContainerChildRow("info1:M.esp", "dial1:M.esp", "DialogTopic", "Responses", 0),
            ],
            [Record("info1:M.esp", "info"), Record("info2:M.esp", "info")]);

        var result = svc.GetChildren(Plugin, "dial1:M.esp");

        Assert.Equal(["info2:M.esp", "info1:M.esp"], result.Select(r => r.FormKey).ToArray());
        Assert.All(result, r => Assert.Equal("info", r.RecordType));
    }

    [Fact]
    public void GetChildren_ReadsTheChildrenOfTheGivenOrigin()
    {
        var modB = new PluginAddress("M.esp", "ModB");
        var reads = new FakeReads(
            new Dictionary<PluginAddress, PluginContent>(),
            [
                Record("dial1:M.esp", "dial", "DataTopic"),
                Record("dial2:M.esp", "dial", "FromTheDataOrigin"),
                Record("dial2:M.esp", "dial", "FromModB", modB),
            ])
        {
            ContainerChildren = new Dictionary<RecordAt, IReadOnlyList<ContainerChildRow>>
            {
                [new RecordAt(Plugin, "qust1:M.esp")] = [new ContainerChildRow("dial1:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 0)],
                [new RecordAt(modB, "qust1:M.esp")] = [new ContainerChildRow("dial2:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 0)],
            },
        };
        var svc = QueryHost.Containers(new StubIndex(reads), Fallout4);

        var result = svc.GetChildren(modB, "qust1:M.esp");

        Assert.Equal(["FromModB"], result.Select(r => r.EditorId));
    }

    [Fact]
    public void GetChildren_ContainerChildRowSearchDidNotReturn_SkipsItInsteadOfThrowingKeyNotFound_ReturnsSurvivors_LogsWarning()
    {
        var entries = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(entries)));
        var svc = Service(
            [
                new ContainerChildRow("dial1:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 0),
                new ContainerChildRow("dial-missing:M.esp", "qust1:M.esp", "Quest", "DialogTopics", 1),
            ],
            [Record("dial1:M.esp", "dial", "TopicA")],
            loggerFactory);

        var result = svc.GetChildren(Plugin, "qust1:M.esp");

        Assert.Equal(["dial1:M.esp"], result.Select(r => r.FormKey).ToArray());
        var warning = Assert.Single(entries, e => e.Level == LogLevel.Warning);
        Assert.Equal(
            "Container child dial-missing:M.esp of qust1:M.esp in M.esp (Data) is indexed in " +
            "container_child but Search(dial) did not return it; omitting.",
            warning.Message);
    }

    [Fact]
    public void GetChildren_OfARecordHoldingNone_IsEmpty()
    {
        var svc = Service([], [Record("dial1:M.esp", "dial", "Topic")]);

        var result = svc.GetChildren(Plugin, "qust1:M.esp");

        Assert.Empty(result);
    }

    [Fact]
    public void GetChildren_NoReads_ThrowsNoLoadOrderException()
    {
        var svc = QueryHost.Containers(new StubIndex(reads: null), Fallout4);
        Assert.Throws<NoLoadOrderException>(() => svc.GetChildren(new PluginAddress("M.esp", "Data"), "qust1:M.esp"));
    }
}
