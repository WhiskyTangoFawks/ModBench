using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

public sealed class EmbeddedChildSearchTests
{
    private const string NewFormKey = "FFF000:EmbedSearch.esp";

    private static Fallout4Mod NewMod() =>
        new(ModKey.FromFileName("EmbedSearch.esp"), Fallout4Release.Fallout4);

    private static string? RekeyedViaRecordDocumentEditsBecauseTheSearchIsCodecInternal(IMajorRecordGetter owner, string formKey) =>
        RecordDocumentEdits.WithEmbeddedChildFormKey(
            RecordTextCodec.SerializeToText(owner, GameRelease.Fallout4), GameRelease.Fallout4,
            RecordTypes.For(GameRelease.Fallout4).RecordTypeOf(owner), formKey, NewFormKey);

    private static void AssertRekeyed(string? text, string formKey)
    {
        Assert.NotNull(text);
        Assert.Contains($"\"FormKey\": \"{NewFormKey}\"", text, StringComparison.Ordinal);
        Assert.DoesNotContain(formKey, text, StringComparison.Ordinal);
    }

    [Fact]
    public void FindsAChildOneLevelDown()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "Cell" };
        var placed = new PlacedObject(mod) { EditorID = "Ref" };
        cell.Temporary.Add(placed);

        AssertRekeyed(RekeyedViaRecordDocumentEditsBecauseTheSearchIsCodecInternal(cell, placed.FormKey.ToString()), placed.FormKey.ToString());
    }

    [Fact]
    public void FindsAChildTwoEmbedLevelsDown_ThroughAWorldspacesTopCell_TheShapeTheOneLevelSearchCouldNotReach()
    {
        var mod = NewMod();
        var worldspace = new Worldspace(mod) { EditorID = "World" };
        var topCell = new Cell(mod) { EditorID = "TopCell" };
        var placed = new PlacedObject(mod) { EditorID = "TopRef" };
        topCell.Temporary.Add(placed);
        worldspace.TopCell = topCell;

        AssertRekeyed(RekeyedViaRecordDocumentEditsBecauseTheSearchIsCodecInternal(worldspace, placed.FormKey.ToString()), placed.FormKey.ToString());
    }

    [Fact]
    public void FindsAResponseThroughItsTopic_InsideTheQuest()
    {
        var mod = NewMod();
        var quest = new Quest(mod) { EditorID = "Quest" };
        var topic = new DialogTopic(mod) { EditorID = "Topic" };
        var response = new DialogResponses(mod) { EditorID = "Response" };
        topic.Responses.Add(response);
        quest.DialogTopics.Add(topic);

        AssertRekeyed(RekeyedViaRecordDocumentEditsBecauseTheSearchIsCodecInternal(quest, response.FormKey.ToString()), response.FormKey.ToString());
    }

    [Fact]
    public void AnswersNullForARecordTheParentDoesNotCarry()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "Cell" };
        var stranger = new PlacedObject(mod) { EditorID = "Elsewhere" };

        Assert.Null(RekeyedViaRecordDocumentEditsBecauseTheSearchIsCodecInternal(cell, stranger.FormKey.ToString()));
    }

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
