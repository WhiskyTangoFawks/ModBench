using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

public sealed class ChildRecordTypesTests
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static readonly Fallout4Mod Mod = new(ModKey.FromFileName("Holds.esp"), Fallout4Release.Fallout4);

    private static string[] Of(IMajorRecordGetter container, CellPlace? place = null) =>
        [.. ChildRecordTypes.Of(
                RecordTableName.Of(container, Schemas), Codec.SerializeToText(container, GameRelease.Fallout4), place,
                Schemas, GameRelease.Fallout4)
            .Order(StringComparer.Ordinal)];

    [Fact]
    public void AQuest_HoldsTopicsBranchesAndScenes()
    {
        Assert.Equal(["dial", "dlbr", "scen"], Of(new Quest(Mod)));
    }

    [Fact]
    public void AQuestHoldingATopic_HoldsMore()
    {
        var quest = new Quest(Mod);
        quest.DialogTopics.Add(new DialogTopic(Mod));

        Assert.Equal(["dial", "dlbr", "scen"], Of(quest));
    }

    [Fact]
    public void ADialogTopic_HoldsResponses()
    {
        Assert.Equal(["info"], Of(new DialogTopic(Mod)));
    }

    [Fact]
    public void AWorldspace_HoldsCells_ThroughItsBlocks_WhenItsPersistentCellIsFilled()
    {
        Assert.Equal(["cell"], Of(new Worldspace(Mod) { TopCell = new Cell(Mod) }));
    }

    [Fact]
    public void AnInteriorCell_HoldsPlacedNpcsObjectsAndNavmeshes_ButNoLandscape()
    {
        Assert.Equal(["achr", "navm", "refr"], Of(new Cell(Mod), CellPlace.Interior));
    }

    [Fact]
    public void AnExteriorCell_HoldsALandscapeToo()
    {
        Assert.Equal(["achr", "land", "navm", "refr"], Of(new Cell(Mod), CellPlace.Exterior));
    }

    [Fact]
    public void AnExteriorCellHoldingALandscape_HoldsNoSecond()
    {
        Assert.Equal(["achr", "navm", "refr"], Of(new Cell(Mod) { Landscape = new Landscape(Mod) }, CellPlace.Exterior));
    }

    [Fact]
    public void AWorldspacesPersistentCell_HoldsOnlyPlacedRecords()
    {
        Assert.Equal(["achr", "refr"], Of(new Cell(Mod), CellPlace.PersistentWorldspaceCell));
    }

    [Fact]
    public void ARecordThatIsNoContainer_HoldsNothing()
    {
        Assert.Empty(Of(new Npc(Mod)));
    }
}
