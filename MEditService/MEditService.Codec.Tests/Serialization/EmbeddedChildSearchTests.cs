using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Serialization;

/// <summary>The search descends every embedded slot at every level, verified through
/// ContainerDocumentEdits, since the search itself is Codec's internal.</summary>
public sealed class EmbeddedChildSearchTests
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static Fallout4Mod NewMod() =>
        new(ModKey.FromFileName("EmbedSearch.esp"), Fallout4Release.Fallout4);

    private static (string RecordType, string Text)? EmbeddedChildIn(IMajorRecordGetter owner, string formKey)
    {
        var ownerType = RecordTableName.Of(owner, Schemas);
        var ownerText = Codec.SerializeToText(owner, GameRelease.Fallout4);
        return ContainerDocumentEdits.EmbeddedChildIn(
            Codec, ownerText, GameRelease.Fallout4, ownerType, formKey, Schemas);
    }

    [Fact]
    public void FindsAChildOneLevelDown()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "Cell" };
        var placed = new PlacedObject(mod) { EditorID = "Ref" };
        cell.Temporary.Add(placed);

        var found = EmbeddedChildIn(cell, placed.FormKey.ToString());

        Assert.NotNull(found);
        Assert.Contains("\"Ref\"", found.Value.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void FindsAChildTwoEmbedLevelsDown_ThroughAWorldspacesTopCell()
    {
        // The shape the one-level search could not reach: the worldspace's document embeds TopCell,
        // which embeds this reference.
        var mod = NewMod();
        var worldspace = new Worldspace(mod) { EditorID = "World" };
        var topCell = new Cell(mod) { EditorID = "TopCell" };
        var placed = new PlacedObject(mod) { EditorID = "TopRef" };
        topCell.Temporary.Add(placed);
        worldspace.TopCell = topCell;

        var found = EmbeddedChildIn(worldspace, placed.FormKey.ToString());

        Assert.NotNull(found);
        Assert.Contains("\"TopRef\"", found.Value.Text, StringComparison.Ordinal);
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

        var found = EmbeddedChildIn(quest, response.FormKey.ToString());

        Assert.NotNull(found);
        Assert.Contains("\"Response\"", found.Value.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void AnswersNullForARecordTheParentDoesNotCarry()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "Cell" };
        var stranger = new PlacedObject(mod) { EditorID = "Elsewhere" };

        Assert.Null(EmbeddedChildIn(cell, stranger.FormKey.ToString()));
    }
}
