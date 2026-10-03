using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

public sealed class ChildRecordReferenceTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _plugin;
    private readonly string _quest;
    private readonly string _topic;
    private readonly string _global;
    private readonly string _keyword;

    public ChildRecordReferenceTests()
    {
        FormKey quest = default, topic = default, global = default, keyword = default;
        _fixture = new PluginFixtureBuilder("child-refs")
            .WithPlugin("ChildRefs.esp", mod =>
            {
                var counter = mod.Globals.AddNewFloat("Counter");
                counter.Data = 1f;
                global = counter.FormKey;
                keyword = mod.Keywords.AddNew("TopicKeyword").FormKey;
                var q = mod.Quests.AddNew("Owner");
                q.TextDisplayGlobals.Add(new FormLink<IGlobalGetter>(global));
                var t = new DialogTopic(mod) { EditorID = "Inside" };
                t.Keyword.SetTo(keyword);
                q.DialogTopics.Add(t);
                quest = q.FormKey;
                topic = t.FormKey;
            }, origin: "ChildMod")
            .BuildScattered()
            .Tracked();
        _plugin = _fixture.Plugins.Single();
        (_quest, _topic, _global, _keyword) = (quest.ToString(), topic.ToString(), global.ToString(), keyword.ToString());
    }

    public void Dispose() => _fixture.Dispose();

    private void AssertEachListsOnlyItsOwn(IRecordReads reads)
    {
        Assert.Equal(_quest, Assert.Single(reads.GetReferencedBy(_global)).FormKey);
        Assert.Equal(_topic, Assert.Single(reads.GetReferencedBy(_keyword)).FormKey);
    }

    [Fact]
    public void AQuestAndTheTopicInsideItEachListWhatTheyReference()
    {
        using var index = Indexes.Reconciled(_fixture);

        AssertEachListsOnlyItsOwn(index.RequireReads());
    }

    [Fact]
    public void AnEditedQuestStillListsOnlyWhatItReferences()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var committed = reads.DocumentOf(_quest, _plugin.KeyOf());

        index.Edit(_plugin, committed, committed.BodyOf().Replace("Owner", "OwnerEdited", StringComparison.Ordinal));

        Assert.Equal("OwnerEdited", reads.DocumentOf(_quest, _plugin.KeyOf()).EditorId);
        AssertEachListsOnlyItsOwn(reads);
    }
}
