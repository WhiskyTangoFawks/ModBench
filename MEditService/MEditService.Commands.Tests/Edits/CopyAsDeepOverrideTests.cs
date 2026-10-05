using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyAsDeepOverrideTests
{
    private static IEnumerable<string> ChildrenOfAQuest(ContainerCopyFixture fixture) =>
        [fixture.DialogTopic.ToString(), fixture.Response1.ToString(), fixture.Response2.ToString(), fixture.Scene.ToString(), fixture.DialogBranch.ToString()];

    [Fact]
    public void ADeepCopyOfAQuest_LandsItWithEveryChildRecordAtAnyDepth()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString()));
        Assert.All(ChildrenOfAQuest(fixture), child => Assert.NotNull(fixture.Document(fixture.DestinationPlugin, child)));
    }

    [Fact]
    public void ADeepCopyOfADialogTopic_CopiesInItsQuestWithItsOwnFields_AndLandsTheTopicWithItsResponses()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.DialogTopic.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.Response1.ToString()));
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.Response2.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.Scene.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.DialogBranch.ToString()));
    }

    [Fact]
    public void ADeepCopyOfAnInteriorCell_LandsItWithItsReferencesNavmeshAndLandscape()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.All(
            new[] { fixture.InteriorCell, fixture.PersistentRef, fixture.TemporaryRef, fixture.Navmesh, fixture.Landscape },
            record => Assert.NotNull(fixture.Document(fixture.DestinationPlugin, record)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ADeepCopyOfAWorldspace_LandsItsPersistentCellAndEveryCellItHolds_EachWithItsReferences(bool trackedSource)
    {
        using var fixture = trackedSource ? ContainerCopyFixture.CreateWithTrackedSource() : ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.All(
            new[]
            {
                fixture.Worldspace, fixture.TopCell, fixture.TopCellRef, fixture.ExteriorCell, fixture.ExteriorPersistentRef,
                fixture.ExteriorTemporaryRef, fixture.OtherBlockCell, fixture.SameBlockCell, fixture.SameSubBlockCell,
            },
            record => Assert.NotNull(fixture.Document(fixture.DestinationPlugin, record)));
        fixture.AssertDestinationCellSitsAt(
            fixture.ExteriorCell.ToString(), ContainerCopyFixture.ExteriorCellEditorId,
            ContainerCopyFixture.ExteriorBlockX, ContainerCopyFixture.ExteriorBlockY,
            ContainerCopyFixture.ExteriorSubX, ContainerCopyFixture.ExteriorSubY);
        fixture.AssertDestinationCellSitsAt(
            fixture.OtherBlockCell.ToString(), ContainerCopyFixture.OtherBlockCellEditorId,
            ContainerCopyFixture.OtherBlockX, ContainerCopyFixture.OtherBlockY,
            ContainerCopyFixture.OtherSubX, ContainerCopyFixture.OtherSubY);
    }

    [Fact]
    public void ADeepCopyOfAnExteriorCell_CopiesInItsWorldspaceWithoutItsOtherCells()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.ExteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorPersistentRef.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.OtherBlockCell.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.TopCell.ToString()));
    }

    [Fact]
    public void ADeepCopyOfAPersistentCell_LandsItWithItsReferences()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.TopCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.TopCellRef.ToString()));
    }

    [Fact]
    public void ADeepCopyOfARecordWithNoChildSlots_LandsAsAnOverride()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.FlatNpc.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.FlatNpc));
    }

    [Fact]
    public void ADeepCopyOfARecordWithNoChildSlots_IntoADestinationHoldingIt_AsksForReplaceLikeAnOverride()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.FlatNpc.ToString(), fixture.DestinationPlugin).Applied);

        var withoutReplace = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.FlatNpc.ToString(), fixture.DestinationPlugin);
        var withReplace = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.FlatNpc.ToString(), fixture.DestinationPlugin, replace: true);

        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, withoutReplace.Refusal);
        Assert.True(withReplace.Applied, withReplace.Message);
    }

    [Fact]
    public void ADeepCopyIntoADestinationHoldingTheRecordButNoneOfItsChildRecords_KeepsItsCopyAndAddsTheChildRecords()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin).Applied);
        var destination = TrackedTree.Repository(fixture.DestinationModFolder);
        const string DestinationsOwnEditorId = "DestinationsOwnQuest";
        SourceEdits.Rewrite<Quest>(
            destination, fixture.DestinationPlugin, new RecordIdentity(fixture.Quest.ToString(), "qust", ContainerCopyFixture.QuestEditorId),
            GameRelease.Fallout4, quest => quest.EditorID = DestinationsOwnEditorId);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(DestinationsOwnEditorId, fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString()).Require().EditorId);
        Assert.All(ChildrenOfAQuest(fixture), child => Assert.NotNull(fixture.Document(fixture.DestinationPlugin, child)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ADeepCopyIntoADestinationHoldingAChildRecord_IsRefusedAndWritesNothing(bool replace)
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.Response1.ToString(), fixture.DestinationPlugin).Applied);
        var before = TreeSnapshot.Of(fixture.DestinationModFolder);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin, replace);

        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, result.Refusal);
        Assert.Equal(before, TreeSnapshot.Of(fixture.DestinationModFolder));
    }

    [Fact]
    public void ADeepCopyOfAWorldspaceIntoADestinationHoldingOneOfItsCells_IsRefusedAndWritesNothing()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.OtherBlockCell.ToString(), fixture.DestinationPlugin).Applied);
        var before = TreeSnapshot.Of(fixture.DestinationModFolder);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin, replace: true);

        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, result.Refusal);
        Assert.Equal(before, TreeSnapshot.Of(fixture.DestinationModFolder));
    }

    [Fact]
    public void ADeepCopyIntoAPluginLoadingBeforeTheOrigin_IsRefusedAsAnUnderride()
    {
        using var fixture = ContainerCopyFixture.CreateWithDestinationLoadingFirst();
        var before = TreeSnapshot.Of(fixture.DestinationModFolder);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin);

        Assert.Equal(RecordEditRefusal.UnderrideDestination, result.Refusal);
        Assert.Equal(before, TreeSnapshot.Of(fixture.DestinationModFolder));
    }

    [Fact]
    public void ADeepCopyOfAWorldspaceThatFailsPartWay_NamesTheCellsThatLandedAndTheCellThatFailed_AndTheOtherItemsStillLand()
    {
        var blocked = RelativeDocumentPathOfACellWrittenByADeepCopy();
        using var fixture = ContainerCopyFixture.Create();
        Directory.CreateDirectory(Path.Combine(fixture.DestinationModFolder, blocked + ".tmp"));
        var unrelated = new RecordAt(fixture.SourcePlugin, fixture.FlatNpc.ToString());
        var worldspace = new RecordAt(fixture.SourcePlugin, fixture.Worldspace.ToString());

        var result = fixture.CopyHandler.CopySync([worldspace, unrelated], CopyMode.DeepOverride, [fixture.DestinationPlugin], replace: false);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(worldspace, refused.Item.Record);
        Assert.Equal([unrelated], result.Landed.Select(landed => landed.Item.Record));
        var cells = new[] { fixture.TopCell, fixture.ExteriorCell, fixture.SameBlockCell, fixture.SameSubBlockCell, fixture.OtherBlockCell };
        var landedCells = cells.Where(cell => fixture.Document(fixture.DestinationPlugin, cell) is not null).ToList();
        var failedCell = Assert.Single(cells.Except(landedCells));
        Assert.Equal(fixture.OtherBlockCell, failedCell);
        Assert.NotEmpty(landedCells);
        Assert.Contains(failedCell.ToString(), refused.Message, StringComparison.Ordinal);
        Assert.All(landedCells, cell => Assert.Contains(cell.ToString(), refused.Message, StringComparison.Ordinal));
    }

    private static string RelativeDocumentPathOfACellWrittenByADeepCopy()
    {
        using var scratch = ContainerCopyFixture.Create();
        Assert.True(scratch.CopyHandler.CopyAsDeepOverride(scratch.SourcePlugin, scratch.Worldspace.ToString(), scratch.DestinationPlugin).Applied);
        var cell = new RecordIdentity(scratch.OtherBlockCell.ToString(), "cell", ContainerCopyFixture.OtherBlockCellEditorId);
        return TrackedTree.Repository(scratch.DestinationModFolder).RelativePathOf(scratch.DestinationPlugin, cell).Require();
    }
}
