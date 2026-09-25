using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

/// <summary>The search descends every embedded slot at every level, verified through
/// RecordDocumentEdits' FormKey change of an embedded child, since the search itself is Codec's internal.</summary>
public sealed class EmbeddedChildSearchTests
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
    private const string NewFormKey = "FFF000:EmbedSearch.esp";

    private static Fallout4Mod NewMod() =>
        new(ModKey.FromFileName("EmbedSearch.esp"), Fallout4Release.Fallout4);

    private static string? Rekeyed(IMajorRecordGetter owner, string formKey) =>
        RecordDocumentEdits.WithEmbeddedChildFormKey(
            Codec, Codec.SerializeToText(owner, GameRelease.Fallout4), GameRelease.Fallout4,
            RecordTableName.Of(owner, Schemas), formKey, NewFormKey);

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

        AssertRekeyed(Rekeyed(cell, placed.FormKey.ToString()), placed.FormKey.ToString());
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

        AssertRekeyed(Rekeyed(worldspace, placed.FormKey.ToString()), placed.FormKey.ToString());
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

        AssertRekeyed(Rekeyed(quest, response.FormKey.ToString()), response.FormKey.ToString());
    }

    [Fact]
    public void AnswersNullForARecordTheParentDoesNotCarry()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "Cell" };
        var stranger = new PlacedObject(mod) { EditorID = "Elsewhere" };

        Assert.Null(Rekeyed(cell, stranger.FormKey.ToString()));
    }
}
