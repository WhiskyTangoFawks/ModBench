using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Serialization;

/// <summary>Populated, not empty, on purpose: a childless container is one file no matter what,
/// so an empty fixture would pass forever without testing anything.</summary>
public class ContainerSingleFileTests
{
    private static readonly Fallout4Mod Mod = new(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);

    [Theory]
    [MemberData(nameof(PopulatedContainers))]
    public async Task PopulatedContainer_SerializesToExactlyOneFile_AndRoundTripsAsItsOwnType(
        IMajorRecord record, Type concreteType, string recordType)
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var dir = Directory.CreateTempSubdirectory("medit-container-single-file-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "record.json");
            await codec.SerializeAsync((IMajorRecordGetter)record, filePath, GameRelease.Fallout4);

            Assert.Equal([filePath], Directory.GetFiles(dir.FullName, "*", SearchOption.AllDirectories));
            Assert.Empty(Directory.GetDirectories(dir.FullName, "*", SearchOption.AllDirectories));

            // A container whose children the writer tried to spill into a sibling folder fails here
            // rather than merely looking wrong, and comes back as its own concrete type from the
            // stated record_type.
            var roundTripped = await codec.DeserializeAsync(filePath, GameRelease.Fallout4, recordType);
            Assert.IsType(concreteType, roundTripped);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    public static IEnumerable<object[]> PopulatedContainers()
    {
        // Cell — every slot Spriggit embeds, so this case is the embed mechanism's layout half.
        var cell = new Cell(Mod) { EditorID = "TestCell", Grid = new CellGrid { Point = new P2Int(1, 2) } };
        cell.Persistent.Add(new PlacedObject(Mod) { EditorID = "PersistentRef" });
        cell.Temporary.Add(new PlacedObject(Mod) { EditorID = "TemporaryRef" });
        cell.NavigationMeshes.Add(new NavigationMesh(Mod));
        cell.Landscape = new Landscape(Mod);
        yield return [cell, typeof(Cell), "Cell"];

        // Worldspace — TopCell is embedded; SubCells is the type most likely to look "fine" for the
        // wrong reason, since Worldspace_Serialization drops it under FilePerRecord by design.
        var worldspace = new Worldspace(Mod) { EditorID = "TestWorld" };
        worldspace.TopCell = new Cell(Mod) { EditorID = "TopCell" };
        worldspace.SubCells.Add(new WorldspaceBlock());
        yield return [worldspace, typeof(Worldspace), "wrld"];

        // Quest — the folder-split half: nothing embeds these children, so here the suppressions
        // are the only thing keeping the count at one file.
        var quest = new Quest(Mod) { EditorID = "TestQuest" };
        quest.DialogBranches.Add(new DialogBranch(Mod));
        quest.DialogTopics.Add(new DialogTopic(Mod));
        quest.Scenes.Add(new Scene(Mod));
        yield return [quest, typeof(Quest), "qust"];

        // DialogTopic — its responses are embedded, the same mechanism as the cell's slots.
        var dialogTopic = new DialogTopic(Mod) { EditorID = "TestDialogTopic" };
        dialogTopic.Responses.Add(new DialogResponses(Mod));
        yield return [dialogTopic, typeof(DialogTopic), "dial"];
    }
}
