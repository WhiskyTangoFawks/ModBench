using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

public sealed class ContainerDocumentEditsTests
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static string Text(IMajorRecordGetter record) => Codec.SerializeToText(record, GameRelease.Fallout4);

    private static JsonElement Read(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }

    private static string EditorIdOf(JsonElement record) =>
        record.GetProperty("EditorID").GetString() ?? throw new InvalidOperationException("Expected a record to carry its EditorID.");

    private static string[] EditorIdsIn(JsonElement owner, string slot) =>
        owner.TryGetProperty(slot, out var held) ? [.. held.EnumerateArray().Select(EditorIdOf)] : [];

    private static string? Appended(Worldspace worldspace, Cell cell) =>
        ContainerDocumentEdits.WithChildAppended(
            Codec, Text(worldspace), GameRelease.Fallout4, RecordTableName.Of(worldspace.GetType(), Schemas),
            worldspace.FormKey.ToString(), "TopCell", Text(cell), RecordTableName.Of(cell.GetType(), Schemas));

    [Fact]
    public void AppendingToAWorldspacesPersistentCell_WhenItHoldsNone_SetsIt()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Append.esp"), Fallout4Release.Fallout4);
        var worldspace = new Worldspace(mod) { EditorID = "World" };
        var cell = new Cell(mod) { EditorID = "Persistent" };

        Assert.Contains(cell.FormKey.ToString(), Appended(worldspace, cell).Require(), StringComparison.Ordinal);
    }

    [Fact]
    public void AppendingToAWorldspacesPersistentCell_WhenItHoldsOne_RefusesNamingBoth()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Append.esp"), Fallout4Release.Fallout4);
        var held = new Cell(mod) { EditorID = "Held" };
        var worldspace = new Worldspace(mod) { EditorID = "World", TopCell = held };
        var other = new Cell(mod) { EditorID = "Other" };

        var refusal = Assert.Throws<ChildSlotHeldByAnotherRecordException>(() => Appended(worldspace, other));

        Assert.Contains(held.FormKey.ToString(), refusal.Message, StringComparison.Ordinal);
        Assert.Contains(other.FormKey.ToString(), refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void MergingChildRecords_OverwritesWhatTheDestinationHoldsInPlace_AddsTheRest_AndKeepsTheDestinationsOwn()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Merge.esp"), Fallout4Release.Fallout4);
        var held = new DialogResponses(mod) { EditorID = "DestinationHeld" };
        var destinationOnly = new DialogResponses(mod) { EditorID = "DestinationOnly" };
        var destination = new DialogTopic(mod) { EditorID = "DestinationTopic" };
        destination.Responses.Add(held);
        destination.Responses.Add(destinationOnly);
        var overwriting = new DialogResponses(held.FormKey, Fallout4Release.Fallout4) { EditorID = "SourceHeld" };
        var added = new DialogResponses(mod) { EditorID = "SourceAdded" };
        var source = new DialogTopic(destination.FormKey, Fallout4Release.Fallout4) { EditorID = "SourceTopic" };
        source.Responses.Add(overwriting);
        source.Responses.Add(added);
        var type = RecordTableName.Of(source.GetType(), Schemas);

        var merged = Read(
            ContainerDocumentEdits.WithChildRecordsMerged(Codec, Text(destination), type, Text(source), type, GameRelease.Fallout4));

        Assert.Equal("DestinationTopic", EditorIdOf(merged));
        Assert.Equal(["SourceHeld", "DestinationOnly", "SourceAdded"], EditorIdsIn(merged, "Responses"));
    }

    [Fact]
    public void MergingChildRecords_AppliesAtEveryDepth()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Merge.esp"), Fallout4Release.Fallout4);
        var destinationResponse = new DialogResponses(mod) { EditorID = "DestinationResponse" };
        var destinationTopic = new DialogTopic(mod) { EditorID = "DestinationTopic" };
        destinationTopic.Responses.Add(destinationResponse);
        var destination = new Quest(mod) { EditorID = "DestinationQuest" };
        destination.DialogTopics.Add(destinationTopic);
        var addedResponse = new DialogResponses(mod) { EditorID = "SourceResponse" };
        var overwritingResponse = new DialogResponses(destinationResponse.FormKey, Fallout4Release.Fallout4) { EditorID = "SourceOverwrite" };
        var sourceTopic = new DialogTopic(destinationTopic.FormKey, Fallout4Release.Fallout4) { EditorID = "SourceTopic" };
        sourceTopic.Responses.Add(overwritingResponse);
        sourceTopic.Responses.Add(addedResponse);
        var source = new Quest(destination.FormKey, Fallout4Release.Fallout4) { EditorID = "SourceQuest" };
        source.DialogTopics.Add(sourceTopic);
        var type = RecordTableName.Of(source.GetType(), Schemas);

        var merged = Read(
            ContainerDocumentEdits.WithChildRecordsMerged(Codec, Text(destination), type, Text(source), type, GameRelease.Fallout4));

        var topic = Assert.Single(merged.GetProperty("DialogTopics").EnumerateArray());
        Assert.Equal("SourceTopic", EditorIdOf(topic));
        Assert.Equal(["SourceOverwrite", "SourceResponse"], EditorIdsIn(topic, "Responses"));
    }

    [Fact]
    public void OverwritingARecord_TakesTheSourcesOwnFields_AndMergesItsChildRecords()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Merge.esp"), Fallout4Release.Fallout4);
        var destination = new DialogTopic(mod) { EditorID = "DestinationTopic" };
        destination.Responses.Add(new DialogResponses(mod) { EditorID = "DestinationOnly" });
        var source = new DialogTopic(destination.FormKey, Fallout4Release.Fallout4) { EditorID = "SourceTopic" };
        source.Responses.Add(new DialogResponses(mod) { EditorID = "SourceAdded" });
        var type = RecordTableName.Of(source.GetType(), Schemas);

        var overwritten = ContainerDocumentEdits.WithRecordOverwritten(
            Codec, Text(destination), type, Text(source), type, GameRelease.Fallout4);

        Assert.Equal("SourceTopic", overwritten.EditorId);
        Assert.Equal(["DestinationOnly", "SourceAdded"], EditorIdsIn(Read(overwritten.Text), "Responses"));
    }

    [Fact]
    public void MergingChildRecordsIntoAWorldspaceWhosePersistentCellIsAnother_RefusesNamingBoth()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Append.esp"), Fallout4Release.Fallout4);
        var held = new Cell(mod) { EditorID = "Held" };
        var destination = new Worldspace(mod) { EditorID = "World", TopCell = held };
        var incoming = new Cell(mod) { EditorID = "Incoming" };
        var source = new Worldspace(mod) { EditorID = "World", TopCell = incoming };
        var type = RecordTableName.Of(source.GetType(), Schemas);

        var refusal = Assert.Throws<ChildSlotHeldByAnotherRecordException>(() => ContainerDocumentEdits.WithChildRecordsMerged(
            Codec, Text(destination), type, Text(source), type, GameRelease.Fallout4));

        Assert.Contains(held.FormKey.ToString(), refusal.Message, StringComparison.Ordinal);
        Assert.Contains(incoming.FormKey.ToString(), refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void MergingChildRecords_MovesAHeldChildHeldInAnotherSlotToTheSlotTheSourceHasIt_AndHoldsItOnce()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Merge.esp"), Fallout4Release.Fallout4);
        var held = new PlacedObject(mod) { EditorID = "DestinationRef" };
        var destination = new Cell(mod) { EditorID = "Cell" };
        destination.Persistent.Add(held);
        var source = new Cell(destination.FormKey, Fallout4Release.Fallout4) { EditorID = "Cell" };
        source.Temporary.Add(new PlacedObject(held.FormKey, Fallout4Release.Fallout4) { EditorID = "SourceRef" });
        var type = RecordTableName.Of(source.GetType(), Schemas);

        var merged = Read(
            ContainerDocumentEdits.WithChildRecordsMerged(Codec, Text(destination), type, Text(source), type, GameRelease.Fallout4));

        Assert.Empty(EditorIdsIn(merged, "Persistent"));
        Assert.Equal(["SourceRef"], EditorIdsIn(merged, "Temporary"));
    }

    [Fact]
    public void MergingChildRecordsIntoAWorldspace_OverwritesThePersistentCellItHoldsUnderTheSameFormKey_KeepingItsOwnChildren()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Merge.esp"), Fallout4Release.Fallout4);
        var heldCell = new Cell(mod) { EditorID = "DestinationCell" };
        heldCell.Temporary.Add(new PlacedObject(mod) { EditorID = "DestinationRef" });
        var destination = new Worldspace(mod) { EditorID = "World", TopCell = heldCell };
        var incomingCell = new Cell(heldCell.FormKey, Fallout4Release.Fallout4) { EditorID = "SourceCell" };
        var source = new Worldspace(mod) { EditorID = "World", TopCell = incomingCell };
        var type = RecordTableName.Of(source.GetType(), Schemas);

        var topCell = Read(
            ContainerDocumentEdits.WithChildRecordsMerged(Codec, Text(destination), type, Text(source), type, GameRelease.Fallout4))
            .GetProperty("TopCell");

        Assert.Equal("SourceCell", EditorIdOf(topCell));
        Assert.Equal(["DestinationRef"], EditorIdsIn(topCell, "Temporary"));
    }
}
