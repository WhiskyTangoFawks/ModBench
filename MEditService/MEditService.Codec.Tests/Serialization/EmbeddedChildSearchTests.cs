using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

public sealed class EmbeddedChildSearchTests
{
    private static Fallout4Mod NewMod() =>
        new(ModKey.FromFileName("EmbedSearch.esp"), Fallout4Release.Fallout4);

    private static EmbeddedChildSpan? Located(IMajorRecordGetter owner, string formKey)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(RecordTextCodec.SerializeToText(owner, GameRelease.Fallout4));
        return EmbeddedChildLocator.Find(bytes, null, formKey, GameRelease.Fallout4);
    }

    [Fact]
    public void AnswersThePathOfAChildOneLevelDown_AsTheSlotAndItsPosition()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "Cell" };
        cell.Temporary.Add(new PlacedObject(mod) { EditorID = "First" });
        var placed = new PlacedObject(mod) { EditorID = "Second" };
        cell.Temporary.Add(placed);

        Assert.Equal(
            [new ChildStep("Temporary", 1)], Located(cell, placed.FormKey.ToString())?.Path);
    }

    [Fact]
    public void AnswersThePathOfAChildTwoEmbedLevelsDown_ThroughAWorldspacesTopCell()
    {
        var mod = NewMod();
        var worldspace = new Worldspace(mod) { EditorID = "World" };
        var topCell = new Cell(mod) { EditorID = "TopCell" };
        var placed = new PlacedObject(mod) { EditorID = "TopRef" };
        topCell.Temporary.Add(placed);
        worldspace.TopCell = topCell;

        Assert.Equal(
            [new ChildStep("TopCell", null), new ChildStep("Temporary", 0)], Located(worldspace, placed.FormKey.ToString())?.Path);
    }
}
