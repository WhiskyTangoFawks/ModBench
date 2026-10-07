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

    private static IMajorRecord Read(string text, string recordType) =>
        (IMajorRecord)RecordTextCodec.DeserializeText(RecordTypeDispatch.For(GameRelease.Fallout4).ConcreteFor(recordType).Require(), text, GameRelease.Fallout4);

    private static string? Appended(Worldspace worldspace, Cell cell) =>
        ContainerDocumentEdits.WithChildAppended(
            Codec, Text(worldspace), GameRelease.Fallout4, RecordTableName.Of(worldspace, Schemas),
            worldspace.FormKey.ToString(), "TopCell", Text(cell), RecordTableName.Of(cell, Schemas));

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
        var type = RecordTableName.Of(source, Schemas);

        var merged = (DialogTopic)Read(
            ContainerDocumentEdits.WithChildRecordsMerged(Codec, Text(destination), type, Text(source), type, GameRelease.Fallout4),
            type);

        Assert.Equal("DestinationTopic", merged.EditorID);
        Assert.Equal(["SourceHeld", "DestinationOnly", "SourceAdded"], merged.Responses.Select(response => response.EditorID));
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
        var type = RecordTableName.Of(source, Schemas);

        var merged = (Quest)Read(
            ContainerDocumentEdits.WithChildRecordsMerged(Codec, Text(destination), type, Text(source), type, GameRelease.Fallout4),
            type);

        var topic = Assert.Single(merged.DialogTopics);
        Assert.Equal("SourceTopic", topic.EditorID);
        Assert.Equal(["SourceOverwrite", "SourceResponse"], topic.Responses.Select(response => response.EditorID));
    }

    [Fact]
    public void OverwritingARecord_TakesTheSourcesOwnFields_AndMergesItsChildRecords()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Merge.esp"), Fallout4Release.Fallout4);
        var destination = new DialogTopic(mod) { EditorID = "DestinationTopic" };
        destination.Responses.Add(new DialogResponses(mod) { EditorID = "DestinationOnly" });
        var source = new DialogTopic(destination.FormKey, Fallout4Release.Fallout4) { EditorID = "SourceTopic" };
        source.Responses.Add(new DialogResponses(mod) { EditorID = "SourceAdded" });
        var type = RecordTableName.Of(source, Schemas);

        var overwritten = ContainerDocumentEdits.WithRecordOverwritten(
            Codec, Text(destination), type, Text(source), type, GameRelease.Fallout4);

        Assert.Equal("SourceTopic", overwritten.EditorId);
        var topic = (DialogTopic)Read(overwritten.Text, type);
        Assert.Equal(["DestinationOnly", "SourceAdded"], topic.Responses.Select(response => response.EditorID));
    }

    [Fact]
    public void MergingChildRecordsIntoAWorldspaceWhosePersistentCellIsAnother_RefusesNamingBoth()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Append.esp"), Fallout4Release.Fallout4);
        var held = new Cell(mod) { EditorID = "Held" };
        var destination = new Worldspace(mod) { EditorID = "World", TopCell = held };
        var incoming = new Cell(mod) { EditorID = "Incoming" };
        var source = new Worldspace(mod) { EditorID = "World", TopCell = incoming };
        var type = RecordTableName.Of(source, Schemas);

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
        var type = RecordTableName.Of(source, Schemas);

        var merged = (Cell)Read(
            ContainerDocumentEdits.WithChildRecordsMerged(Codec, Text(destination), type, Text(source), type, GameRelease.Fallout4),
            type);

        Assert.Empty(merged.Persistent);
        Assert.Equal(["SourceRef"], merged.Temporary.Select(placed => placed.EditorID));
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
        var type = RecordTableName.Of(source, Schemas);

        var merged = (Worldspace)Read(
            ContainerDocumentEdits.WithChildRecordsMerged(Codec, Text(destination), type, Text(source), type, GameRelease.Fallout4),
            type);

        var topCell = merged.TopCell.Require();
        Assert.Equal("SourceCell", topCell.EditorID);
        Assert.Equal(["DestinationRef"], topCell.Temporary.Select(placed => placed.EditorID));
    }
}
