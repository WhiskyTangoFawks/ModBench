using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #440 Arc A: widens <see cref="RecordEditService.CopyRecordAsOverride"/> off the blanket
/// <c>ContainerRecordNotYetSupported</c> refusal #436 shipped with — a container's own top-level
/// record (Cell, Worldspace, Quest) can now be copied as override. This suite is Slice 1's own
/// contract: the widening is safe before any embed-stripping (Slice 2) or parent-chain (Slices 6/7)
/// code exists, proven on a type with nothing embedded to strip — a Quest's own fields land, and its
/// folder-split children (DialogTopics) never do, because a plain "Copy as Override" is own-fields-only
/// for every record type, containers included (xEdit parity — only "Deep copy as override" carries
/// children, #551's own gesture).
/// </summary>
public sealed class RecordEditServiceContainerCopyTests
{
    private static RecordEditService ServiceFor(ISessionManager sessions) =>
        new(sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void CopyRecordAsOverride_OnAQuest_Succeeds_OwnFieldsLand_NoFolderSplitChildrenCopied()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Sessions).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var doc = fixture.Sessions.Index!.GetDocument(fixture.Quest.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(doc);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, doc!.EditorId);

        // Own fields only — the DialogTopic never lands as its own file, and the destination's Quest
        // directory carries no DialogTopics subfolder at all.
        Assert.Null(fixture.Sessions.Index!.GetDocument(fixture.DialogTopic.ToString(), fixture.DestinationPlugin));
        var questDirectory = Path.GetDirectoryName(fixture.DestinationSourceFileContaining(ContainerCopyFixture.QuestEditorId))!;
        Assert.False(Directory.Exists(Path.Combine(questDirectory, "DialogTopics")));
    }

    // #440 Slice 2 (AC3's plain-copy half): a Cell's own fields land, but its four embedded slots
    // (Persistent/Temporary/NavigationMeshes/Landscape — all inline in its own document since #450)
    // come back empty, not verbatim. Their FormKeys never land as their own rows in the destination
    // either, matching "empty child lists" literally, not just an empty JSON array.
    [Fact]
    public void CopyRecordAsOverride_OnAnInteriorCell_Succeeds_OwnFieldsLand_EmbeddedSlotsEmpty()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Sessions).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var doc = fixture.Sessions.Index!.GetDocument(fixture.InteriorCell.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(doc);
        Assert.Equal(ContainerCopyFixture.InteriorCellEditorId, doc!.EditorId);
        Assert.Contains(
            $"\"WaterHeight\": {ContainerCopyFixture.InteriorCellWaterHeight:0.0}",
            File.ReadAllText(fixture.DestinationSourceFileContaining(ContainerCopyFixture.InteriorCellEditorId)),
            StringComparison.Ordinal);

        Assert.Null(fixture.Sessions.Index!.GetDocument(fixture.PersistentRef.ToString(), fixture.DestinationPlugin));
        Assert.Null(fixture.Sessions.Index!.GetDocument(fixture.TemporaryRef.ToString(), fixture.DestinationPlugin));

        var cellFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.InteriorCellEditorId);
        var text = File.ReadAllText(cellFile);
        Assert.DoesNotContain(ContainerCopyFixture.PersistentRefEditorId, text, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.TemporaryRefEditorId, text, StringComparison.Ordinal);
        // #440 review (Spec 1): the comment above claims all four embedded slots come back empty —
        // Navmesh/Landscape were populated in the fixture but never actually checked until now.
        Assert.DoesNotContain(ContainerCopyFixture.NavmeshEditorId, text, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.LandscapeEditorId, text, StringComparison.Ordinal);
    }

    // #440 Slice 2: same "own fields only" rule for a Worldspace — TopCell (its one embedded slot,
    // per SpriggitEmbeddedSlots) comes back empty rather than carrying the source's TopCell along.
    [Fact]
    public void CopyRecordAsOverride_OnAWorldspace_Succeeds_OwnFieldsLand_TopCellEmpty()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Sessions).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var doc = fixture.Sessions.Index!.GetDocument(fixture.Worldspace.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(doc);
        Assert.Equal(ContainerCopyFixture.WorldspaceEditorId, doc!.EditorId);

        Assert.Null(fixture.Sessions.Index!.GetDocument(fixture.TopCell.ToString(), fixture.DestinationPlugin));
        var worldFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.WorldspaceEditorId);
        Assert.DoesNotContain(ContainerCopyFixture.TopCellEditorId, File.ReadAllText(worldFile), StringComparison.Ordinal);
    }

    // #440 Slice 6 (AC2): copying a placed reference into a plugin that already overrides its Cell
    // appends into that Cell's own document — untouched otherwise, Partial Form flag included (it was
    // false before this copy and stays false, since an ordinary explicit copy is never auto-created).
    [Fact]
    public void CopyRecordAsOverride_OnAPlacedReference_WhenDestinationAlreadyOverridesTheCell_Appends()
    {
        using var fixture = ContainerCopyFixture.Create();
        var service = ServiceFor(fixture.Sessions);
        Assert.True(service.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.PersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var childDoc = fixture.Sessions.Index!.GetDocument(fixture.PersistentRef.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(childDoc);
        Assert.Equal(ContainerCopyFixture.PersistentRefEditorId, childDoc!.EditorId);

        var cellFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.InteriorCellEditorId);
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, File.ReadAllText(cellFile), StringComparison.Ordinal);
        // The negative control this copy must not touch: the reference never copied at all.
        Assert.DoesNotContain(ContainerCopyFixture.TemporaryRefEditorId, File.ReadAllText(cellFile), StringComparison.Ordinal);

        var cellDoc = fixture.Sessions.Index!.GetDocument(fixture.InteriorCell.ToString(), fixture.DestinationPlugin);
        Assert.False(cellDoc!.IsPartialForm);
    }

    // #440 Slice 6's own permanent boundary — still current for a Worldspace's own TopCell
    // specifically, post-#549: TopCell's own cell_location row carries no block/sub/grid at all
    // (PlacementWalker.WalkWorldspace hardcodes those null for it), so there is nothing for
    // MintExteriorCell to place it at — genuinely out of #549 Arc B's own scope (a real SubCells
    // exterior cell), not a residual gap in it. That genuine case is
    // CopyRecordAsOverride_OnAGenuineExteriorPlacedReference_MintsWrldAndCellOverrides below.
    [Fact]
    public void CopyRecordAsOverride_OnATopCellPlacedReference_Refuses_WhenDestinationHasNoCellOverride()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Sessions).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.TopCellRef.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerParentMissingInDestination, result.Refusal);
        Assert.Null(fixture.Sessions.Index!.GetDocument(fixture.TopCellRef.ToString(), fixture.DestinationPlugin));
    }

    // #440 review (Spec 2): the direct sibling of the placed-reference test above — copying the
    // TopCell itself as override (not one of its children) hits its own, separate check
    // (RecordEditService.cs's isCell branch in CopyRecordAsOverride, not CopyPlacedReferenceAsOverride)
    // and needs its own test rather than relying on the placed-reference variant to stand in for it.
    // Still refuses post-#549 for the same reason as its sibling above.
    [Fact]
    public void CopyRecordAsOverride_OnATopCellItself_Refuses()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Sessions).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.TopCell.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerParentMissingInDestination, result.Refusal);
        Assert.Null(fixture.Sessions.Index!.GetDocument(fixture.TopCell.ToString(), fixture.DestinationPlugin));
    }

    // #549 Arc B (AC1): the genuine SubCells exterior case — destination has neither the worldspace
    // nor the cell. Both mint as bare, Partial Form ancestors; the REFR itself lands with its real
    // fields, in the same slot (Persistent/Temporary) the source has it in; cell_location for the new
    // cell matches the source's own row exactly (Slice 1's write, exercised end to end).
    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorPlacedReference_MintsWrldAndCellOverrides_WhenDestinationHasNeither()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Sessions).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.ExteriorPersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var index = fixture.Sessions.Index!;
        var worldspaceDoc = index.GetDocument(fixture.Worldspace.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(worldspaceDoc);
        Assert.True(worldspaceDoc!.IsPartialForm);

        var cellDoc = index.GetDocument(fixture.ExteriorCell.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(cellDoc);
        Assert.True(cellDoc!.IsPartialForm);

        var refDoc = index.GetDocument(fixture.ExteriorPersistentRef.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(refDoc);
        Assert.Equal(ContainerCopyFixture.ExteriorPersistentRefEditorId, refDoc!.EditorId);

        var cellFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.ExteriorPersistentRefEditorId);
        var cellText = File.ReadAllText(cellFile);
        Assert.Contains(ContainerCopyFixture.ExteriorPersistentRefEditorId, cellText, StringComparison.Ordinal);
        // The negative control: the sibling temporary ref never copied, and never rode along.
        Assert.DoesNotContain(ContainerCopyFixture.ExteriorTemporaryRefEditorId, cellText, StringComparison.Ordinal);
        Assert.Null(index.GetDocument(fixture.ExteriorTemporaryRef.ToString(), fixture.DestinationPlugin));

        var expectedLocation = index.GetCellLocation(fixture.SourcePlugin, fixture.ExteriorCell.ToString());
        Assert.Equal(expectedLocation, index.GetCellLocation(fixture.DestinationPlugin, fixture.ExteriorCell.ToString()));
    }

    // #549 Arc B (AC1): the direct sibling of the placed-reference case above — copying the exterior
    // Cell itself as override. The requested record (the Cell) lands with its own real fields and is
    // NOT Partial Form; only the auto-created WRLD ancestor is. The rival this guards against: an
    // implementation that Partial-Forms everything in the newly-minted chain, including the record the
    // caller actually asked to copy.
    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorCellItself_MintsWrldOverride_CellLandsOwnFieldsOnly()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Sessions).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.ExteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var index = fixture.Sessions.Index!;
        var worldspaceDoc = index.GetDocument(fixture.Worldspace.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(worldspaceDoc);
        Assert.True(worldspaceDoc!.IsPartialForm);

        var cellDoc = index.GetDocument(fixture.ExteriorCell.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(cellDoc);
        Assert.Equal(ContainerCopyFixture.ExteriorCellEditorId, cellDoc!.EditorId);
        Assert.False(cellDoc.IsPartialForm);

        // Own fields only: neither ref rides along with a plain (non-deep) copy of the Cell.
        Assert.Null(index.GetDocument(fixture.ExteriorPersistentRef.ToString(), fixture.DestinationPlugin));
        Assert.Null(index.GetDocument(fixture.ExteriorTemporaryRef.ToString(), fixture.DestinationPlugin));

        var expectedLocation = index.GetCellLocation(fixture.SourcePlugin, fixture.ExteriorCell.ToString());
        Assert.Equal(expectedLocation, index.GetCellLocation(fixture.DestinationPlugin, fixture.ExteriorCell.ToString()));
    }

    // #440 Slice 7: the interior sibling of the case above — no destination override of the Cell
    // exists yet, but interior placement carries no gameplay meaning to compute, so one auto-creates:
    // bare fields (WaterHeight never copied from the source — genuine xEdit parity), Partial Form
    // flagged (a deliberate mEdit-specific divergence from xEdit's own bare/unflagged ancestor —
    // CreateInteriorCellParent's own doc comment has the full argument), the reference placed inside it.
    [Fact]
    public void CopyRecordAsOverride_OnAnInteriorPlacedReference_AutoCreatesTheCellAsPartialForm_WhenMissing()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Sessions).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.PersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var cellDoc = fixture.Sessions.Index!.GetDocument(fixture.InteriorCell.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(cellDoc);
        Assert.True(cellDoc!.IsPartialForm);

        // The destination has no other Cell yet, so exactly one RecordData.json under Cells/ exists —
        // no EditorID to search by (the auto-created cell is bare, per this slice's own contract).
        var cellFile = Directory
            .EnumerateFiles(Path.Combine(fixture.DestinationSourceRoot, "Cells"), "RecordData.json", SearchOption.AllDirectories)
            .Single();
        Assert.DoesNotContain(
            $"\"WaterHeight\": {ContainerCopyFixture.InteriorCellWaterHeight:0.0}",
            File.ReadAllText(cellFile),
            StringComparison.Ordinal);
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, File.ReadAllText(cellFile), StringComparison.Ordinal);

        var childDoc = fixture.Sessions.Index!.GetDocument(fixture.PersistentRef.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(childDoc);
    }
}
