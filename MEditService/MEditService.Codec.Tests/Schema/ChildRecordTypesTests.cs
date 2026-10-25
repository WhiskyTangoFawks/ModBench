using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

public sealed class ChildRecordTypesTests
{
    private static readonly Fallout4Mod Mod = new(ModKey.FromFileName("Holds.esp"), Fallout4Release.Fallout4);

    private static string[] Holding(params string[] others) =>
        [.. PlacedRecordTables.Names.Concat(others).Order(StringComparer.Ordinal)];

    private static string[] Of(IMajorRecordGetter container, CellPlace? place = null) =>
        [.. ChildRecordTypes.Of(
                RecordTypes.For(GameRelease.Fallout4).RecordTypeOf(container), RecordTextCodec.SerializeToText(container, GameRelease.Fallout4),
                ContainerChildFields.EnumerateChildren(container).Select(c => (c.SlotName, c.Child.FormKey.ToString())), place,
                GameRelease.Fallout4)
            .Order(StringComparer.Ordinal)];

    [Fact]
    public void AQuest_HoldsTopicsBranchesAndScenes()
    {
        Assert.Equal(["dial", "dlbr", "scen"], Of(new Quest(Mod)));
    }

    [Fact]
    public void AQuestHoldingATopic_CanHoldAnother_ForAListMemberStaysOpenWhenFilled()
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
    public void AnInteriorCell_HoldsPlacedRecordsAndNavmeshes_ButNoLandscape()
    {
        Assert.Equal(Holding("navm"), Of(new Cell(Mod), CellPlace.Interior));
    }

    [Fact]
    public void AnExteriorCell_HoldsALandscapeToo()
    {
        Assert.Equal(Holding("land", "navm"), Of(new Cell(Mod), CellPlace.Exterior));
    }

    [Fact]
    public void AnExteriorCellHoldingALandscape_HoldsNoSecond()
    {
        Assert.Equal(Holding("navm"), Of(new Cell(Mod) { Landscape = new Landscape(Mod) }, CellPlace.Exterior));
    }

    [Theory]
    [InlineData(CellPlace.Interior)]
    [InlineData(CellPlace.Exterior)]
    [InlineData(CellPlace.PersistentWorldspaceCell)]
    public void ACellCarryingThePersistentFlag_HoldsOnlyPlacedRecords(CellPlace place)
    {
        Assert.Equal(Holding(), Of(new Cell(Mod) { MajorRecordFlagsRaw = PersistentFlag.Bit }, place));
    }

    [Fact]
    public void AWorldspacesPersistentCell_WithoutThePersistentFlag_HoldsNavmeshesToo()
    {
        Assert.Equal(Holding("navm"), Of(new Cell(Mod), CellPlace.PersistentWorldspaceCell));
    }

    [Fact]
    public void ACellsPlace_IsWhereItsStructureSitsIt()
    {
        Assert.Equal(CellPlace.Interior, CellStructure.Interior(0, 0).Place);
        Assert.Equal(CellPlace.Exterior, new CellStructure("000801:Holds.esp", 0, -1, 0, -1, IsInterior: false).Place);
        Assert.Equal(
            CellPlace.PersistentWorldspaceCell, new CellStructure("000801:Holds.esp", null, null, null, null, IsInterior: false).Place);
    }

    [Fact]
    public void ADeletedContainer_HoldsNothing()
    {
        Assert.Empty(Of(new Quest(Mod) { MajorRecordFlagsRaw = DeletedFlag.Bit }));
    }

    private static IEnumerable<(GameRelease Release, string Type, CellPlace? Place)> ContainersInEveryPlace() =>
        from release in new[] { GameRelease.Fallout4, GameRelease.SkyrimSE, GameRelease.Starfield }
        let types = RecordTypes.For(release)
        from type in SharedSchemaReflector.Instance.GetSchemas(release).Keys.Where(types.HasChildSlots)
        from place in types.IsCell(type) ? Enum.GetValues<CellPlace>().Cast<CellPlace?>() : new CellPlace?[] { null }
        select (release, type, place);

    public static TheoryData<GameRelease, string, CellPlace?> EveryContainerInEveryPlaceItCanSit()
    {
        var data = new TheoryData<GameRelease, string, CellPlace?>();
        foreach (var (release, type, place) in ContainersInEveryPlace()) data.Add(release, type, place);
        return data;
    }

    [Theory]
    [MemberData(nameof(EveryContainerInEveryPlaceItCanSit))]
    public void EveryTypeHasChildFieldsCallsAContainer_HoldsSomethingWhenEmpty_InEveryPlaceACellCanSit(GameRelease release, string type, CellPlace? place)
    {
        var text = RecordTextCodec.BlankDocument(type, release, Document.Empty.With("000800:Holds.esp", RecordMembers.FormKey));

        Assert.NotEmpty(ChildRecordTypes.Of(type, text, [], place, release));
    }

    [Fact]
    public void ARecordThatIsNoContainer_HoldsNothing()
    {
        Assert.Empty(Of(new Npc(Mod)));
    }

    [Fact]
    public void AContainerWhoseTextIsNoRecordDocument_IsRefusedRatherThanReadAsNotDeleted()
    {
        Assert.Throws<InvalidOperationException>(() => ChildRecordTypes.Of("cell", "[]", [], CellPlace.Interior, GameRelease.Fallout4));
    }
}
