using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class ContainerChildQueryServiceTests : IDisposable
{
    private const string PluginName = "M.esp";
    private const string Quest = "000800:M.esp";
    private const string BranchA = "000801:M.esp";
    private const string TopicB = "000802:M.esp";
    private const string SceneA = "000803:M.esp";
    private const string TopicA = "000804:M.esp";
    private const string ResponseA = "000805:M.esp";
    private const string ResponseB = "000806:M.esp";
    private const string ChildlessQuest = "000807:M.esp";
    private const Fallout4Release Release = Fallout4Release.Fallout4;
    private static readonly PluginAddress Plugin = new(PluginName, PluginOrigin.DataDirectory);

    private readonly ScatteredFixtureData _fixture;
    private readonly OpenedIndex _index;

    public ContainerChildQueryServiceTests()
    {
        _fixture = new PluginFixtureBuilder("container-child-query")
            .WithPlugin(PluginName, mod =>
            {
                var topicA = new DialogTopic(FormKey.Factory(TopicA), Release);
                topicA.Responses.Add(new DialogResponses(FormKey.Factory(ResponseA), Release));
                topicA.Responses.Add(new DialogResponses(FormKey.Factory(ResponseB), Release));
                var quest = new Quest(FormKey.Factory(Quest), Release);
                quest.DialogBranches.Add(new DialogBranch(FormKey.Factory(BranchA), Release));
                quest.DialogTopics.Add(new DialogTopic(FormKey.Factory(TopicB), Release));
                quest.DialogTopics.Add(topicA);
                quest.Scenes.Add(new Scene(FormKey.Factory(SceneA), Release));
                mod.Quests.Add(quest);
                mod.Quests.Add(new Quest(FormKey.Factory(ChildlessQuest), Release));
            })
            .BuildScattered();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public void GetChildren_Quest_KeepsTheIndexsOrder_WhateverTheChildrensTypes()
    {
        var result = _index.Containers.GetChildren(Plugin, Quest);

        Assert.Equal([BranchA, TopicB, SceneA, TopicA], result.Select(r => r.FormKey));
        Assert.Equal(["dlbr", "dial", "scen", "dial"], result.Select(r => r.RecordType));
    }

    [Fact]
    public void GetChildren_SaysWhichChildHoldsChildrenOfItsOwn_ForADialChildIsItselfAContainerThePluginsTreeExpands()
    {
        var result = _index.Containers.GetChildren(Plugin, Quest);

        Assert.True(result.Single(r => r.FormKey == TopicA).HasContainerChildren);
        Assert.False(result.Single(r => r.FormKey == TopicB).HasContainerChildren);
    }

    [Fact]
    public void GetChildren_SaysWhichChildIsAContainer_AnEmptyTopicIncluded()
    {
        var result = _index.Containers.GetChildren(Plugin, Quest);

        Assert.True(result.Single(r => r.FormKey == TopicB).IsContainer);
        Assert.False(result.Single(r => r.FormKey == BranchA).IsContainer);
    }

    [Fact]
    public void GetChildren_DialogTopic_ReturnsItsResponses_TaggedInfo()
    {
        var result = _index.Containers.GetChildren(Plugin, TopicA);

        Assert.Equal([ResponseA, ResponseB], result.Select(r => r.FormKey));
        Assert.All(result, r => Assert.Equal("info", r.RecordType));
    }

    [Fact]
    public void GetChildren_OfARecordHoldingNone_IsEmpty()
    {
        Assert.Empty(_index.Containers.GetChildren(Plugin, ChildlessQuest));
    }

    [Fact]
    public void GetChildren_ReadsTheChildrenOfTheGivenOrigin()
    {
        var modB = new PluginAddress(PluginName, "ModB");
        using var fixture = new PluginFixtureBuilder("container-child-origin")
            .WithPlugin(PluginName, mod =>
            {
                var quest = new Quest(FormKey.Factory(Quest), Release);
                quest.DialogTopics.Add(new DialogTopic(FormKey.Factory(TopicA), Release) { EditorID = "FromTheDataOrigin" });
                mod.Quests.Add(quest);
            })
            .WithPlugin(PluginName, mod =>
            {
                var quest = new Quest(FormKey.Factory(Quest), Release);
                quest.DialogTopics.Add(new DialogTopic(FormKey.Factory(TopicB), Release) { EditorID = "FromModB" });
                mod.Quests.Add(quest);
            }, origin: modB.Origin)
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);

        var result = index.Containers.GetChildren(modB, Quest);

        Assert.Equal(["FromModB"], result.Select(r => r.EditorId));
        Assert.Empty(index.Containers.GetChildren(Plugin, Quest));
    }

    [Fact]
    public void GetChildren_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        using var index = Indexes.Open(new LoadOrderHolder());

        Assert.Throws<NoLoadOrderException>(() => index.Containers.GetChildren(Plugin, Quest));
    }
}
