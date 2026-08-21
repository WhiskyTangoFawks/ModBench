using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Serialization;

/// <summary>
/// #370 Slice F (ADR-0040/#387 amendment): container-shaped records vendor shallow. Per the
/// orchestrator's framing, this asserts the <b>outcome</b> at the codec seam — one record, one
/// file, clean round-trip, children absent — regardless of mechanism (<see cref="ContainerStripFields"/>'s
/// own doc comment records the generic-vs-hand-maintained investigation; this test would read
/// identically either way).
/// </summary>
public class ContainerShallowVendoringTests
{
    private static readonly Fallout4Mod Mod = new(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);

    private static Cell MakePopulatedCell()
    {
        var cell = new Cell(Mod) { EditorID = "TestCell", Grid = new CellGrid { Point = new P2Int(1, 2) } };
        cell.Persistent.Add(new PlacedObject(Mod) { EditorID = "PersistentRef" });
        cell.Temporary.Add(new PlacedObject(Mod) { EditorID = "TemporaryRef" });
        cell.NavigationMeshes.Add(new NavigationMesh(Mod));
        cell.Landscape = new Landscape(Mod);
        return cell;
    }

    [Fact]
    public async Task ShallowStrippedCell_SerializesToExactlyOneFile_AndRoundTripsWithChildrenAbsent()
    {
        var cell = MakePopulatedCell();
        ContainerStripFields.StripInPlace(cell);

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var dir = Directory.CreateTempSubdirectory("medit-shallow-cell-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "cell.json");
            await codec.SerializeAsync(cell, filePath, GameRelease.Fallout4);

            // One record, one file — no sibling Persistent/Temporary/NavigationMeshes folders next
            // to it, which is exactly the cross-contamination hazard #387 probed (two containers
            // serialized into one directory silently merge their children on read).
            Assert.Equal([filePath], Directory.GetFiles(dir.FullName, "*", SearchOption.AllDirectories));

            var roundTripped = (Cell)await codec.DeserializeAsync(filePath, GameRelease.Fallout4);

            // Clean round-trip: the library's readers Clear() a list whose folder is absent, by
            // design (ADR-0040 amendment) — children come back empty/null, not missing-and-broken.
            Assert.Empty(roundTripped.Persistent);
            Assert.Empty(roundTripped.Temporary);
            Assert.Empty(roundTripped.NavigationMeshes);
            Assert.Null(roundTripped.Landscape);

            // The parent's own fields survive the strip untouched.
            Assert.Equal("TestCell", roundTripped.EditorID);
            Assert.Equal(new P2Int(1, 2), roundTripped.Grid!.Point);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    // The layout claim ("one record, one file") extended across every container type ADR-0040
    // names, not just Cell — Worldspace in particular because Worldspace_Serialization's own
    // upstream defect (SubCells dropped even by the whole-mod path) means this is the type most
    // likely to look "fine" for the wrong reason if the strip were ever skipped.
    [Theory]
    [MemberData(nameof(OtherContainerTypes))]
    public async Task ShallowStrippedContainer_SerializesToExactlyOneFile(IMajorRecord record, Type concreteType)
    {
        ContainerStripFields.StripInPlace(record);

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var dir = Directory.CreateTempSubdirectory("medit-shallow-container-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "record.json");
            await codec.SerializeAsync((IMajorRecordGetter)record, filePath, GameRelease.Fallout4);

            Assert.Equal([filePath], Directory.GetFiles(dir.FullName, "*", SearchOption.AllDirectories));

            // Round-trips without throwing — a broken shallow strip (e.g. a list left non-empty
            // that the writer still tries to spill into a sibling folder) would fail here, not just
            // look wrong — and comes back as its own concrete type, which the text now names for
            // itself (MutagenObjectType) instead of the caller asserting it on the text's behalf.
            var roundTripped = await codec.DeserializeAsync(filePath, GameRelease.Fallout4);
            Assert.IsType(concreteType, roundTripped);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    public static IEnumerable<object[]> OtherContainerTypes()
    {
        var worldspace = new Worldspace(Mod) { EditorID = "TestWorld" };
        worldspace.TopCell = new Cell(Mod) { EditorID = "TopCell" };
        worldspace.SubCells.Add(new WorldspaceBlock());
        yield return [worldspace, typeof(Worldspace)];

        var quest = new Quest(Mod) { EditorID = "TestQuest" };
        quest.DialogBranches.Add(new DialogBranch(Mod));
        quest.DialogTopics.Add(new DialogTopic(Mod));
        yield return [quest, typeof(Quest)];

        var dialogTopic = new DialogTopic(Mod) { EditorID = "TestDialogTopic" };
        dialogTopic.Responses.Add(new DialogResponses(Mod));
        yield return [dialogTopic, typeof(DialogTopic)];
    }
}
