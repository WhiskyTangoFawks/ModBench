using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

/// <summary>editor-referenced-by.md, The tree, story 5: a child record's references are its own,
/// whichever record carries it inline.</summary>
public class ChildRecordReferenceTests
{
    [Fact]
    public void AQuestAndTheTopicInsideItEachListWhatTheyReference()
    {
        FormKey quest = default, topic = default, global = default, keyword = default;
        using var fixture = new PluginFixtureBuilder("child-refs")
            .WithPlugin("ChildRefs.esp", mod =>
            {
                global = mod.Globals.AddNewFloat("Counter").FormKey;
                keyword = mod.Keywords.AddNew("TopicKeyword").FormKey;
                var q = mod.Quests.AddNew("Owner");
                q.TextDisplayGlobals.Add(new FormLink<IGlobalGetter>(global));
                var t = new DialogTopic(mod) { EditorID = "Inside" };
                t.Keyword.SetTo(keyword);
                q.DialogTopics.Add(t);
                quest = q.FormKey;
                topic = t.FormKey;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        Assert.Equal(quest.ToString(), Assert.Single(reads.GetReferencedBy(global.ToString())).FormKey);
        Assert.Equal(topic.ToString(), Assert.Single(reads.GetReferencedBy(keyword.ToString())).FormKey);
    }
}
