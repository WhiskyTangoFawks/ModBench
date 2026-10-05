using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

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

    [Fact]
    public void ADeepCopyOfAWorldspace_LandsItsPersistentCellAndEveryCellItHolds_EachWithItsReferences()
    {
        using var fixture = ContainerCopyFixture.Create();
        AssertAWorldspaceLandsWhole(fixture);
    }

    [Fact]
    public void ADeepCopyOfAWorldspaceFromATrackedSource_LandsItsPersistentCellAndEveryCellItHolds_EachWithItsReferences()
    {
        using var fixture = ContainerCopyFixture.CreateWithTrackedSource();
        AssertAWorldspaceLandsWhole(fixture);
    }

    private static void AssertAWorldspaceLandsWhole(ContainerCopyFixture fixture)
    {
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

    [Fact]
    public void ADeepCopyIntoADestinationHoldingAChildRecord_AsksForReplaceAndWritesNothing()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.Response1.ToString(), fixture.DestinationPlugin).Applied);
        var before = TreeSnapshot.Of(fixture.DestinationModFolder);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin);

        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, result.Refusal);
        Assert.Equal(before, TreeSnapshot.Of(fixture.DestinationModFolder));
    }

    [Fact]
    public void ADeepCopyOfAWorldspaceIntoADestinationHoldingOneOfItsCells_AsksForReplaceAndWritesNothing()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.OtherBlockCell.ToString(), fixture.DestinationPlugin).Applied);
        var before = TreeSnapshot.Of(fixture.DestinationModFolder);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin);

        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, result.Refusal);
        Assert.Equal(before, TreeSnapshot.Of(fixture.DestinationModFolder));
    }

    [Fact]
    public void AReplacingDeepCopyOfAQuest_OverwritesTheChildRecordsTheDestinationHolds_KeepsItsCopyOfTheQuestAndItsOwnChildren_AndAddsTheRest()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.Response1.ToString(), fixture.DestinationPlugin).Applied);
        var destination = TrackedTree.Repository(fixture.DestinationModFolder);
        var ownResponse = FormKey.Factory($"0ABCDE:{ContainerCopyFixture.DestinationPluginName}");
        SourceEdits.Rewrite<Quest>(
            destination, fixture.DestinationPlugin, new RecordIdentity(fixture.Quest.ToString(), "qust", ContainerCopyFixture.QuestEditorId),
            GameRelease.Fallout4, quest => quest.EditorID = "DestinationsOwnQuest");
        SourceEdits.Rewrite<DialogTopic>(
            destination, fixture.DestinationPlugin, new RecordIdentity(fixture.DialogTopic.ToString(), "dial", ContainerCopyFixture.DialogTopicEditorId),
            GameRelease.Fallout4, topic =>
            {
                topic.Responses.Add(new DialogResponses(ownResponse, Fallout4Release.Fallout4) { EditorID = "DestinationsOwnResponse" });
                topic.Responses.Single(response => response.FormKey == fixture.Response1).EditorID = "EditedResponse1";
            });

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        Assert.Equal("DestinationsOwnQuest", fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString()).Require().EditorId);
        Assert.Equal(ContainerCopyFixture.Response1EditorId, fixture.Document(fixture.DestinationPlugin, fixture.Response1.ToString()).Require().EditorId);
        Assert.Equal("DestinationsOwnResponse", fixture.Document(fixture.DestinationPlugin, ownResponse.ToString()).Require().EditorId);
        Assert.All(ChildrenOfAQuest(fixture), child => Assert.NotNull(fixture.Document(fixture.DestinationPlugin, child)));
    }

    [Fact]
    public void AReplacingDeepCopyOfAWorldspace_OverwritesTheCellsTheDestinationHolds_KeepingTheirOwnChildRecords_AndAddsTheRest()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.ExteriorCell.ToString(), fixture.DestinationPlugin).Applied);
        var ownRef = FormKey.Factory($"0ABCDE:{ContainerCopyFixture.DestinationPluginName}");
        SourceEdits.Rewrite<Cell>(
            TrackedTree.Repository(fixture.DestinationModFolder), fixture.DestinationPlugin,
            new RecordIdentity(fixture.ExteriorCell.ToString(), "cell", ContainerCopyFixture.ExteriorCellEditorId),
            GameRelease.Fallout4, cell =>
            {
                cell.EditorID = "EditedCell";
                cell.Temporary.Add(new PlacedObject(ownRef, Fallout4Release.Fallout4) { EditorID = "DestinationsOwnRef" });
            });

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(ContainerCopyFixture.ExteriorCellEditorId, fixture.Document(fixture.DestinationPlugin, fixture.ExteriorCell.ToString()).Require().EditorId);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, ownRef.ToString()));
        Assert.All(
            new[] { fixture.ExteriorPersistentRef, fixture.ExteriorTemporaryRef, fixture.TopCell, fixture.OtherBlockCell },
            record => Assert.NotNull(fixture.Document(fixture.DestinationPlugin, record)));
    }

    [Fact]
    public void AReplacingDeepCopyOfAWorldspace_OverwritesARefHeldInAHeldCell_AndOverwritesAPersistentCellRefTheSourceKeepsInANumberedCell()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.ExteriorCell.ToString(), fixture.DestinationPlugin).Applied);
        var destination = TrackedTree.Repository(fixture.DestinationModFolder);
        SourceEdits.Rewrite<Cell>(
            destination, fixture.DestinationPlugin,
            new RecordIdentity(fixture.ExteriorCell.ToString(), "cell", ContainerCopyFixture.ExteriorCellEditorId),
            GameRelease.Fallout4,
            cell => cell.Temporary.Add(new PlacedObject(fixture.ExteriorTemporaryRef, Fallout4Release.Fallout4) { EditorID = "EditedInCell" }));
        SourceEdits.Rewrite<Worldspace>(
            destination, fixture.DestinationPlugin,
            new RecordIdentity(fixture.Worldspace.ToString(), "wrld", ContainerCopyFixture.WorldspaceEditorId),
            GameRelease.Fallout4,
            worldspace => worldspace.TopCell = new Cell(fixture.TopCell, Fallout4Release.Fallout4)
            {
                Persistent = { new PlacedObject(fixture.ExteriorPersistentRef, Fallout4Release.Fallout4) { EditorID = "EditedInPersistentCell" } },
            });

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(ContainerCopyFixture.ExteriorTemporaryRefEditorId, fixture.Document(fixture.DestinationPlugin, fixture.ExteriorTemporaryRef).Require().EditorId);
        Assert.Equal(ContainerCopyFixture.ExteriorPersistentRefEditorId, fixture.Document(fixture.DestinationPlugin, fixture.ExteriorPersistentRef).Require().EditorId);
        Assert.DoesNotContain(
            fixture.ExteriorPersistentRef.ToString(), fixture.Document(fixture.DestinationPlugin, fixture.Worldspace).Require().Body, StringComparison.Ordinal);
    }

    [Fact]
    public void AReplacingDeepCopyOfAnInteriorCell_HoldsARefOnceWhenTheDestinationHasItInTheOtherGroup()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin).Applied);
        SourceEdits.Rewrite<Cell>(
            TrackedTree.Repository(fixture.DestinationModFolder), fixture.DestinationPlugin,
            new RecordIdentity(fixture.InteriorCell.ToString(), "cell", ContainerCopyFixture.InteriorCellEditorId),
            GameRelease.Fallout4,
            cell => cell.Persistent.Add(new PlacedObject(fixture.TemporaryRef, Fallout4Release.Fallout4) { EditorID = "EditedInPersistent" }));

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        var body = fixture.Document(fixture.DestinationPlugin, fixture.InteriorCell).Require().Body;
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(body, System.Text.RegularExpressions.Regex.Escape(fixture.TemporaryRef.ToString())));
        Assert.Equal(ContainerCopyFixture.TemporaryRefEditorId, fixture.Document(fixture.DestinationPlugin, fixture.TemporaryRef).Require().EditorId);
    }

    [Fact]
    public void ADeepCopyOfAWorldspaceIntoADestinationWhosePersistentCellIsAnother_IsRefusedAsASlotHeldByAnotherRecordAndWritesNothing()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin).Applied);
        SourceEdits.Rewrite<Worldspace>(
            TrackedTree.Repository(fixture.DestinationModFolder), fixture.DestinationPlugin,
            new RecordIdentity(fixture.Worldspace.ToString(), "wrld", ContainerCopyFixture.WorldspaceEditorId),
            GameRelease.Fallout4,
            worldspace => worldspace.TopCell = new Cell(FormKey.Factory($"0ABCDE:{ContainerCopyFixture.DestinationPluginName}"), Fallout4Release.Fallout4));
        var before = TreeSnapshot.Of(fixture.DestinationModFolder);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin, replace: true);

        Assert.Equal(RecordEditRefusal.ChildSlotHeldByAnotherRecord, result.Refusal);
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
        var inLandingOrder = NumberedCellsInLandingOrder(ContainerCopyFixture.Create());
        var blocked = inLandingOrder[1];
        using var fixture = ContainerCopyFixture.Create();
        Directory.CreateDirectory(Path.Combine(fixture.DestinationModFolder, RelativeDocumentPathOfACellWrittenByADeepCopy(blocked) + ".tmp"));
        var unrelated = new RecordAt(fixture.SourcePlugin, fixture.FlatNpc.ToString());
        var worldspace = new RecordAt(fixture.SourcePlugin, fixture.Worldspace.ToString());

        var result = fixture.CopyHandler.CopySync([worldspace, unrelated], CopyMode.DeepOverride, [fixture.DestinationPlugin], replace: false);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(worldspace, refused.Item.Record);
        Assert.Equal([unrelated], result.Landed.Select(landed => landed.Item.Record));
        var landedOnes = new[] { fixture.TopCell.ToString(), inLandingOrder[0] };
        var neverReached = inLandingOrder[2..];
        Assert.All(landedOnes, cell => Assert.NotNull(fixture.Document(fixture.DestinationPlugin, cell)));
        Assert.All(landedOnes, cell => Assert.Contains(cell, refused.Message, StringComparison.Ordinal));
        Assert.Contains(blocked, refused.Message, StringComparison.Ordinal);
        Assert.All(neverReached, cell => Assert.Null(fixture.Document(fixture.DestinationPlugin, cell)));
        Assert.All(neverReached, cell => Assert.DoesNotContain(cell, refused.Message, StringComparison.Ordinal));
    }

    [Fact]
    public void ADeepCopyOfAQuestWithNoTopics_IntoADestinationHoldingIt_AsksForReplaceLikeAnOverride()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.ChildlessQuest.ToString(), fixture.DestinationPlugin).Applied);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.ChildlessQuest.ToString(), fixture.DestinationPlugin);

        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, result.Refusal);
    }

    [Fact]
    public void ADeepCopyOfAQuestWithNoTopics_IntoADestinationHoldingIt_ReplacesItsFieldsWhenToldTo()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.ChildlessQuest.ToString(), fixture.DestinationPlugin).Applied);
        SourceEdits.Rewrite<Quest>(
            TrackedTree.Repository(fixture.DestinationModFolder), fixture.DestinationPlugin,
            new RecordIdentity(fixture.ChildlessQuest.ToString(), "qust", ContainerCopyFixture.ChildlessQuestEditorId),
            GameRelease.Fallout4, quest => quest.EditorID = "Edited");

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.ChildlessQuest.ToString(), fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(ContainerCopyFixture.ChildlessQuestEditorId, fixture.Document(fixture.DestinationPlugin, fixture.ChildlessQuest).Require().EditorId);
    }

    [Fact]
    public void ADeepCopyOfATopicWithNoResponses_IntoADestinationHoldingIt_AsksForReplaceLikeAnOverride()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.BareTopic.ToString(), fixture.DestinationPlugin).Applied);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.BareTopic.ToString(), fixture.DestinationPlugin);

        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, result.Refusal);
    }

    [Fact]
    public void ADeepCopyOfATopicWithNoResponses_IntoADestinationHoldingIt_ReplacesItsFieldsWhenToldTo()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.BareTopic.ToString(), fixture.DestinationPlugin).Applied);
        SourceEdits.Rewrite<DialogTopic>(
            TrackedTree.Repository(fixture.DestinationModFolder), fixture.DestinationPlugin,
            new RecordIdentity(fixture.BareTopic.ToString(), "dial", ContainerCopyFixture.BareTopicEditorId),
            GameRelease.Fallout4, topic => topic.EditorID = "Edited");

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.BareTopic.ToString(), fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(ContainerCopyFixture.BareTopicEditorId, fixture.Document(fixture.DestinationPlugin, fixture.BareTopic).Require().EditorId);
    }

    [Fact]
    public void ADeepCopyOfADialogTopicIntoADestinationHoldingItButNoneOfItsResponses_KeepsItsCopyAndAddsTheResponses()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.DialogTopic.ToString(), fixture.DestinationPlugin).Applied);
        const string DestinationsOwnEditorId = "DestinationsOwnTopic";
        SourceEdits.Rewrite<DialogTopic>(
            TrackedTree.Repository(fixture.DestinationModFolder), fixture.DestinationPlugin,
            new RecordIdentity(fixture.DialogTopic.ToString(), "dial", ContainerCopyFixture.DialogTopicEditorId),
            GameRelease.Fallout4, topic => topic.EditorID = DestinationsOwnEditorId);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.DialogTopic.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(DestinationsOwnEditorId, fixture.Document(fixture.DestinationPlugin, fixture.DialogTopic).Require().EditorId);
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.Response1));
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.Response2));
    }

    [Fact]
    public void ADeepCopyOfAWorldspaceIntoADestinationHoldingItButNoneOfItsCells_KeepsItsCopyAndAddsTheCells()
    {
        using var fixture = ContainerCopyFixture.Create();
        Assert.True(fixture.CopyHandler.CopyAsOverride(fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin).Applied);
        const string DestinationsOwnEditorId = "DestinationsOwnWorld";
        SourceEdits.Rewrite<Worldspace>(
            TrackedTree.Repository(fixture.DestinationModFolder), fixture.DestinationPlugin,
            new RecordIdentity(fixture.Worldspace.ToString(), "wrld", ContainerCopyFixture.WorldspaceEditorId),
            GameRelease.Fallout4, worldspace => worldspace.EditorID = DestinationsOwnEditorId);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(DestinationsOwnEditorId, fixture.Document(fixture.DestinationPlugin, fixture.Worldspace).Require().EditorId);
        Assert.All(
            new[] { fixture.TopCell, fixture.TopCellRef, fixture.ExteriorCell, fixture.OtherBlockCell, fixture.SameBlockCell, fixture.SameSubBlockCell },
            record => Assert.NotNull(fixture.Document(fixture.DestinationPlugin, record)));
    }

    [Fact]
    public void ADeepCopyIntoAPluginLoadingBeforeTheOriginOfAChildRecord_IsRefusedAsAnUnderrideAndWritesNothing()
    {
        using var fixture = new LateChildFixture();
        var before = TreeSnapshot.Of(fixture.DestinationModFolder);

        var result = fixture.CopyHandler.CopyAsDeepOverride(fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin);

        Assert.Equal(RecordEditRefusal.UnderrideDestination, result.Refusal);
        Assert.Equal(before, TreeSnapshot.Of(fixture.DestinationModFolder));
    }

    private static string[] NumberedCellsInLandingOrder(ContainerCopyFixture fixture)
    {
        using (fixture)
        {
            return
            [
                .. new[] { fixture.ExteriorCell, fixture.SameBlockCell, fixture.SameSubBlockCell, fixture.OtherBlockCell }
                    .Select(cell => cell.ToString())
                    .Order(StringComparer.Ordinal),
            ];
        }
    }

    private static string RelativeDocumentPathOfACellWrittenByADeepCopy(string cell)
    {
        using var scratch = ContainerCopyFixture.Create();
        Assert.True(scratch.CopyHandler.CopyAsDeepOverride(scratch.SourcePlugin, scratch.Worldspace.ToString(), scratch.DestinationPlugin).Applied);
        var identity = scratch.Document(scratch.DestinationPlugin, cell).Require().Identity;
        return TrackedTree.Repository(scratch.DestinationModFolder).RelativePathOf(scratch.DestinationPlugin, identity).Require();
    }
}
