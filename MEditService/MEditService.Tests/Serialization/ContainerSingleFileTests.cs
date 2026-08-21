using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Serialization;

/// <summary>
/// #370 Slice F's layout claim, kept and re-based on #450's document shape: <b>one source unit, one
/// file</b>, for every container type, with children <i>populated</i>. It used to hold because the
/// caller stripped the children off first; it now holds for two different reasons at once — the
/// slots Spriggit embeds are written inline into the parent's own file, and the ones it does not are
/// suppressed on their way to the filesystem
/// (<c>RecordTextCodec.DiscardChildRecordStreams</c>/<c>NoRecordFolders</c>). Either mechanism
/// breaking spills sibling folders next to the record's file, which is the #387 cross-contamination
/// hazard this has always guarded.
///
/// <para>Populated, not empty, on purpose: a childless container is one file no matter what any of
/// this does, so an empty fixture here would pass forever without testing anything.
/// <see cref="DocumentShapeParityTests"/> makes the same check for a quest, tied there to the byte
/// parity it protects; the breadth across all four container shapes lives here.</para>
/// </summary>
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

            // Round-trips without throwing — a container whose children the writer tried to spill
            // into a sibling folder fails here, not merely looks wrong — and comes back as its own
            // concrete type, reconstituted from the record_type the caller states (#450: none of
            // these four is path-ambiguous, so none of their documents self-describes).
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
        yield return [cell, typeof(Cell), "cell"];

        // Worldspace — TopCell is embedded; SubCells is the type most likely to look "fine" for the
        // wrong reason, since Worldspace_Serialization drops it under FilePerRecord by design.
        var worldspace = new Worldspace(Mod) { EditorID = "TestWorld" };
        worldspace.TopCell = new Cell(Mod) { EditorID = "TopCell" };
        worldspace.SubCells.Add(new WorldspaceBlock());
        yield return [worldspace, typeof(Worldspace), "wrld"];

        // Quest and DialogTopic — the folder-split half: nothing embeds these children, so here the
        // suppressions are the only thing keeping the count at one file.
        var quest = new Quest(Mod) { EditorID = "TestQuest" };
        quest.DialogBranches.Add(new DialogBranch(Mod));
        quest.DialogTopics.Add(new DialogTopic(Mod));
        quest.Scenes.Add(new Scene(Mod));
        yield return [quest, typeof(Quest), "qust"];

        var dialogTopic = new DialogTopic(Mod) { EditorID = "TestDialogTopic" };
        dialogTopic.Responses.Add(new DialogResponses(Mod));
        yield return [dialogTopic, typeof(DialogTopic), "dial"];
    }
}
