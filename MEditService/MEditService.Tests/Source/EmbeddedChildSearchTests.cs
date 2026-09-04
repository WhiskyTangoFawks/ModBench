using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>The search's upper bound is invisible from the integration suite: a dialog topic has its own
/// file, so <c>FindEmbeddedChild</c> is never called for one.</summary>
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
    public void DoesNotDescendIntoFolderSplitChildren()
    {
        // A quest's dialog topic is a folder-split child with its own source file.
        var mod = NewMod();
        var quest = new Quest(mod) { EditorID = "Quest" };
        var topic = new DialogTopic(mod) { EditorID = "Topic" };
        var response = new DialogResponses(mod) { EditorID = "Response" };
        topic.Responses.Add(response);
        quest.DialogTopics.Add(topic);

        // The topic itself is a direct child, so it is found — that is the search doing its job, and
        // it is harmless because the resolver never asks about a record that has its own file.
        Assert.NotNull(ContainerChildFields.FindEmbeddedChild(quest, topic.FormKey.ToString()));

        // Its response is one level further, behind a folder-split slot, and must not be reached.
        Assert.Null(ContainerChildFields.FindEmbeddedChild(quest, response.FormKey.ToString()));
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
