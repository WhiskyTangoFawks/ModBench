using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Serialization;

/// <summary>The search descends every embedded slot at every level, and hands back the direct
/// parent of what it finds.</summary>
public sealed class EmbeddedChildSearchTests
{
    private static Fallout4Mod NewMod() =>
        new(ModKey.FromFileName("EmbedSearch.esp"), Fallout4Release.Fallout4);

    [Fact]
    public void FindsAChildOneLevelDown()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "Cell" };
        var placed = new PlacedObject(mod) { EditorID = "Ref" };
        cell.Temporary.Add(placed);

        var found = ContainerChildFields.FindEmbeddedChild(cell, placed.FormKey.ToString());

        Assert.NotNull(found);
        Assert.Equal("Temporary", found!.Value.SlotName);
        // The real object out of the parent's graph, not a copy — mutating it is how the edit lands.
        Assert.Same(placed, found.Value.Child);
    }

    [Fact]
    public void FindsAChildTwoEmbedLevelsDown_ThroughAWorldspacesTopCell()
    {
        // The shape the one-level search could not reach: the worldspace's document embeds TopCell,
        // which embeds this reference. Two levels, one file, no file of the child's own anywhere.
        var mod = NewMod();
        var worldspace = new Worldspace(mod) { EditorID = "World" };
        var topCell = new Cell(mod) { EditorID = "TopCell" };
        var placed = new PlacedObject(mod) { EditorID = "TopRef" };
        topCell.Temporary.Add(placed);
        worldspace.TopCell = topCell;

        var found = ContainerChildFields.FindEmbeddedChild(worldspace, placed.FormKey.ToString());

        Assert.NotNull(found);
        Assert.Same(placed, found!.Value.Child);
    }

    [Fact]
    public void FindsAResponseThroughItsTopic_InsideTheQuest_NamingTheTopicAsItsParent()
    {
        var mod = NewMod();
        var quest = new Quest(mod) { EditorID = "Quest" };
        var topic = new DialogTopic(mod) { EditorID = "Topic" };
        var response = new DialogResponses(mod) { EditorID = "Response" };
        topic.Responses.Add(response);
        quest.DialogTopics.Add(topic);

        var found = ContainerChildFields.FindEmbeddedChild(quest, response.FormKey.ToString());

        Assert.NotNull(found);
        Assert.Same(response, found!.Value.Child);
        Assert.Same(topic, found.Value.Parent);
        Assert.Equal((nameof(DialogTopic.Responses), 0), (found.Value.SlotName, found.Value.SlotIndex));
    }

    [Fact]
    public void AnswersNullForARecordTheParentDoesNotCarry()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "Cell" };
        var stranger = new PlacedObject(mod) { EditorID = "Elsewhere" };

        Assert.Null(ContainerChildFields.FindEmbeddedChild(cell, stranger.FormKey.ToString()));
    }
}
