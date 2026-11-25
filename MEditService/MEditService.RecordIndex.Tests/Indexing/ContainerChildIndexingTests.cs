using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.RecordIndex.Tests.Indexing;

public sealed class ContainerChildIndexingTests
{
    private static readonly PluginAddress Key = new("Dialogue.esp", PluginOrigin.DataDirectory);

    private static List<string> Children(OpenedIndex index, string parentFormKey) =>
        [.. index.Queries.GetContainerChildren(Key, parentFormKey).Value().Select(c => c.FormKey)];

    [Fact]
    public void ADeletedPlugin_LeavesNoContainerChildren()
    {
        string quest = "", topic = "";
        using var fixture = new PluginFixtureBuilder("container-child")
            .WithPlugin(Key.Name, mod =>
            {
                var t = new DialogTopic(mod) { EditorID = "Topic" };
                t.Responses.Add(new DialogResponses(mod) { EditorID = "Response" });
                var q = mod.Quests.AddNew("Quest");
                q.DialogTopics.Add(t);
                (quest, topic) = (q.FormKey.ToString(), t.FormKey.ToString());
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        Assert.NotEmpty(Children(index, quest));
        Assert.NotEmpty(Children(index, topic));

        File.Delete(fixture.Plugins.Single().Path);
        index.NextCheck();

        Assert.Empty(Children(index, quest));
        Assert.Empty(Children(index, topic));
    }
}
