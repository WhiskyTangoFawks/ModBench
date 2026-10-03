using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Codec.Tests.Serialization;

public class ContainerSingleFileTests
{
    private static readonly Fallout4Mod Mod = new(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);

    [Theory]
    [MemberData(nameof(PopulatedContainers))]
    public async Task PopulatedContainer_SerializesToExactlyOneFile_AndRoundTripsAsItsOwnConcreteTypeFromTheStatedRecordType_PopulatedBecauseAChildlessContainerIsOneFileNoMatterWhat(
        IMajorRecord record, Type concreteType, string recordType)
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        using var dir = new ScratchDirectory("medit-container-single-file-");
        var filePath = Path.Combine(dir.Path, "record.json");
        await codec.SerializeAsync((IMajorRecordGetter)record, filePath, GameRelease.Fallout4);

        Assert.Equal([filePath], Directory.GetFiles(dir.Path, "*", SearchOption.AllDirectories));
        Assert.Empty(Directory.GetDirectories(dir.Path, "*", SearchOption.AllDirectories));

        var roundTripped = codec.DeserializeFile(filePath, GameRelease.Fallout4, recordType);
        Assert.IsType(concreteType, roundTripped);
    }

    public static IEnumerable<object[]> PopulatedContainers()
    {
        var cellWithEverySlotSpriggitEmbedsSoItIsTheEmbedMechanismsLayoutHalf = new Cell(Mod) { EditorID = "TestCell", Grid = new CellGrid { Point = new P2Int(1, 2) } };
        cellWithEverySlotSpriggitEmbedsSoItIsTheEmbedMechanismsLayoutHalf.Persistent.Add(new PlacedObject(Mod) { EditorID = "PersistentRef" });
        cellWithEverySlotSpriggitEmbedsSoItIsTheEmbedMechanismsLayoutHalf.Temporary.Add(new PlacedObject(Mod) { EditorID = "TemporaryRef" });
        cellWithEverySlotSpriggitEmbedsSoItIsTheEmbedMechanismsLayoutHalf.NavigationMeshes.Add(new NavigationMesh(Mod));
        cellWithEverySlotSpriggitEmbedsSoItIsTheEmbedMechanismsLayoutHalf.Landscape = new Landscape(Mod);
        yield return [cellWithEverySlotSpriggitEmbedsSoItIsTheEmbedMechanismsLayoutHalf, typeof(Cell), "Cell"];

        var worldspaceWhoseSubCellsLookFineForTheWrongReasonSinceWorldspaceSerializationDropsThemUnderFilePerRecordByDesign = new Worldspace(Mod) { EditorID = "TestWorld" };
        worldspaceWhoseSubCellsLookFineForTheWrongReasonSinceWorldspaceSerializationDropsThemUnderFilePerRecordByDesign.TopCell = new Cell(Mod) { EditorID = "TopCell" };
        worldspaceWhoseSubCellsLookFineForTheWrongReasonSinceWorldspaceSerializationDropsThemUnderFilePerRecordByDesign.SubCells.Add(new WorldspaceBlock());
        yield return [worldspaceWhoseSubCellsLookFineForTheWrongReasonSinceWorldspaceSerializationDropsThemUnderFilePerRecordByDesign, typeof(Worldspace), "wrld"];

        var questWithEveryChildSlotEmbeddedTransitivelySinceTheTopicCarriesAResponse = new Quest(Mod) { EditorID = "TestQuest" };
        questWithEveryChildSlotEmbeddedTransitivelySinceTheTopicCarriesAResponse.DialogBranches.Add(new DialogBranch(Mod));
        var questTopic = new DialogTopic(Mod);
        questTopic.Responses.Add(new DialogResponses(Mod));
        questWithEveryChildSlotEmbeddedTransitivelySinceTheTopicCarriesAResponse.DialogTopics.Add(questTopic);
        questWithEveryChildSlotEmbeddedTransitivelySinceTheTopicCarriesAResponse.Scenes.Add(new Scene(Mod));
        yield return [questWithEveryChildSlotEmbeddedTransitivelySinceTheTopicCarriesAResponse, typeof(Quest), "qust"];

        var dialogTopicWhoseResponsesAreEmbeddedByTheSameMechanismAsTheCellsSlots = new DialogTopic(Mod) { EditorID = "TestDialogTopic" };
        dialogTopicWhoseResponsesAreEmbeddedByTheSameMechanismAsTheCellsSlots.Responses.Add(new DialogResponses(Mod));
        yield return [dialogTopicWhoseResponsesAreEmbeddedByTheSameMechanismAsTheCellsSlots, typeof(DialogTopic), "dial"];
    }
}
