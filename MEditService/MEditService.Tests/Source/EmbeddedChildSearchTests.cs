using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>
/// <c>ContainerChildFields.FindEmbeddedChild</c> at the unit level — how far the search into a
/// container's object graph goes, and where it stops (#453 review finding 2).
///
/// <para><b>Why this exists as well as the integration tests.</b> <c>EmbeddedChildEditTests</c> drives
/// the same code through <c>RecordEditService</c>, which is the right level for "the edit lands in the
/// right file". But the search's <i>upper</i> bound is invisible from there: a Quest's dialog topic has
/// a source file of its own, so <c>SourceUnitResolver</c> resolves it directly and
/// <c>FindEmbeddedChild</c> is never called for one at all. Removing the bound entirely leaves the
/// whole integration suite green — measured, by doing exactly that. The bound is real and worth
/// keeping, so it is asserted where it can actually be observed.</para>
/// </summary>
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
        // A quest's dialog topic is a child, but a folder-split one with its own source file — and its
        // responses live in files below that. Reaching either through the quest's own graph would let
        // an edit be written into the quest's document, while compile and ingest keep reading the
        // child's own file: a silently lost edit. The search must decline both.
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
