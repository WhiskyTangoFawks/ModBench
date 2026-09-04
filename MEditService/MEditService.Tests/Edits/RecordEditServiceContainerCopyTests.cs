using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>A plain "Copy as Override" is own-fields-only for every record type, containers
/// included (xEdit parity: only "Deep copy as override" carries children).</summary>
public sealed class RecordEditServiceContainerCopyTests
{
    private static RecordEditService ServiceFor(ILoadOrderMirror mirror) =>
        new(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void CopyRecordAsOverride_OnAQuest_Succeeds_OwnFieldsLand_NoFolderSplitChildrenCopied()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var doc = fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.Quest.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(doc);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, doc!.EditorId);

        // Own fields only — the DialogTopic never lands as its own file, and the destination's Quest
        // directory carries no DialogTopics subfolder at all.
        Assert.Null(fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.DialogTopic.ToString(), fixture.DestinationPlugin));
        var questDirectory = Path.GetDirectoryName(fixture.DestinationSourceFileContaining(ContainerCopyFixture.QuestEditorId))!;
        Assert.False(Directory.Exists(Path.Combine(questDirectory, "DialogTopics")));
    }

    // A Cell's own fields land, but its four embedded slots come back empty, not verbatim. Their
    // FormKeys never land as rows in the destination either, matching "empty child lists" literally.
    [Fact]
    public void CopyRecordAsOverride_OnAnInteriorCell_Succeeds_OwnFieldsLand_EmbeddedSlotsEmpty()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var doc = fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.InteriorCell.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(doc);
        Assert.Equal(ContainerCopyFixture.InteriorCellEditorId, doc!.EditorId);
        Assert.Contains(
            $"\"WaterHeight\": {ContainerCopyFixture.InteriorCellWaterHeight:0.0}",
            File.ReadAllText(fixture.DestinationSourceFileContaining(ContainerCopyFixture.InteriorCellEditorId)),
            StringComparison.Ordinal);

        Assert.Null(fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.PersistentRef.ToString(), fixture.DestinationPlugin));
        Assert.Null(fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.TemporaryRef.ToString(), fixture.DestinationPlugin));

        var cellFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.InteriorCellEditorId);
        var text = File.ReadAllText(cellFile);
        Assert.DoesNotContain(ContainerCopyFixture.PersistentRefEditorId, text, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.TemporaryRefEditorId, text, StringComparison.Ordinal);
        // The comment above claims all four embedded slots come back empty —
        // Navmesh/Landscape are populated in the fixture so their absence here is a real check.
        Assert.DoesNotContain(ContainerCopyFixture.NavmeshEditorId, text, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerCopyFixture.LandscapeEditorId, text, StringComparison.Ordinal);
    }

    // Same "own fields only" rule for a Worldspace — TopCell (its one embedded slot,
    // per EmbeddedSlots) comes back empty rather than carrying the source's TopCell along.
    [Fact]
    public void CopyRecordAsOverride_OnAWorldspace_Succeeds_OwnFieldsLand_TopCellEmpty()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var doc = fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.Worldspace.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(doc);
        Assert.Equal(ContainerCopyFixture.WorldspaceEditorId, doc!.EditorId);

        Assert.Null(fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.TopCell.ToString(), fixture.DestinationPlugin));
        var worldFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.WorldspaceEditorId);
        Assert.DoesNotContain(ContainerCopyFixture.TopCellEditorId, File.ReadAllText(worldFile), StringComparison.Ordinal);
    }

    // Copying a placed reference into a plugin that already overrides its Cell appends into that
    // Cell's document, untouched otherwise, Partial Form flag included: an ordinary explicit copy is
    // never auto-created.
    [Fact]
    public void CopyRecordAsOverride_OnAPlacedReference_WhenDestinationAlreadyOverridesTheCell_Appends()
    {
        using var fixture = ContainerCopyFixture.Create();
        var service = ServiceFor(fixture.Mirror);
        Assert.True(service.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.PersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var childDoc = fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.PersistentRef.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(childDoc);
        Assert.Equal(ContainerCopyFixture.PersistentRefEditorId, childDoc!.EditorId);

        var cellFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.InteriorCellEditorId);
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, File.ReadAllText(cellFile), StringComparison.Ordinal);
        // The negative control this copy must not touch: the reference never copied at all.
        Assert.DoesNotContain(ContainerCopyFixture.TemporaryRefEditorId, File.ReadAllText(cellFile), StringComparison.Ordinal);

        var cellDoc = fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.InteriorCell.ToString(), fixture.DestinationPlugin);
        Assert.False(cellDoc!.IsPartialForm);
    }

    // A permanent boundary for a Worldspace's TopCell: its cell_location row carries no
    // block/sub/grid at all, so there is nothing for MintExteriorCell to place it at.
    [Fact]
    public void CopyRecordAsOverride_OnATopCellPlacedReference_Refuses_WhenDestinationHasNoCellOverride()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.TopCellRef.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerParentMissingInDestination, result.Refusal);
        Assert.Null(fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.TopCellRef.ToString(), fixture.DestinationPlugin));
    }

    // Copying the TopCell itself hits its own check (the isCell branch in CopyRecordAsOverride, not
    // CopyPlacedReferenceAsOverride), so the placed-reference variant cannot stand in for it.
    [Fact]
    public void CopyRecordAsOverride_OnATopCellItself_Refuses()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.TopCell.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerParentMissingInDestination, result.Refusal);
        Assert.Null(fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.TopCell.ToString(), fixture.DestinationPlugin));
    }

    // The genuine SubCells exterior case. Both ancestors mint as bare Partial Forms; the REFR lands
    // with its real fields in the same slot the source has it in, and cell_location for the new cell
    // matches the source's row exactly.
    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorPlacedReference_MintsWrldAndCellOverrides_WhenDestinationHasNeither()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.ExteriorPersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var index = fixture.Mirror.Index!;
        var worldspaceDoc = index.At(RecordRef.Effective).GetDocument(fixture.Worldspace.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(worldspaceDoc);
        Assert.True(worldspaceDoc!.IsPartialForm);

        var cellDoc = index.At(RecordRef.Effective).GetDocument(fixture.ExteriorCell.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(cellDoc);
        Assert.True(cellDoc!.IsPartialForm);

        var refDoc = index.At(RecordRef.Effective).GetDocument(fixture.ExteriorPersistentRef.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(refDoc);
        Assert.Equal(ContainerCopyFixture.ExteriorPersistentRefEditorId, refDoc!.EditorId);

        var cellFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.ExteriorPersistentRefEditorId);
        var cellText = File.ReadAllText(cellFile);
        Assert.Contains(ContainerCopyFixture.ExteriorPersistentRefEditorId, cellText, StringComparison.Ordinal);
        // The negative control: the sibling temporary ref never copied, and never rode along.
        Assert.DoesNotContain(ContainerCopyFixture.ExteriorTemporaryRefEditorId, cellText, StringComparison.Ordinal);
        Assert.Null(index.At(RecordRef.Effective).GetDocument(fixture.ExteriorTemporaryRef.ToString(), fixture.DestinationPlugin));

        var expectedLocation = index.At(RecordRef.Effective).GetCellLocation(fixture.SourcePlugin, fixture.ExteriorCell.ToString());
        Assert.Equal(expectedLocation, index.At(RecordRef.Effective).GetCellLocation(fixture.DestinationPlugin, fixture.ExteriorCell.ToString()));
    }

    // "REFR in the same Persistent/Temporary slot as the source" — the
    // Temporary half, so an implementation that hardcodes the Persistent slot cannot pass.
    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorTemporaryPlacedReference_LandsInTheTemporarySlot()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.ExteriorTemporaryRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var index = fixture.Mirror.Index!;
        Assert.True(index.At(RecordRef.Effective).GetDocument(fixture.ExteriorCell.ToString(), fixture.DestinationPlugin)!.IsPartialForm);
        Assert.NotNull(index.At(RecordRef.Effective).GetDocument(fixture.ExteriorTemporaryRef.ToString(), fixture.DestinationPlugin));
        Assert.Null(index.At(RecordRef.Effective).GetDocument(fixture.ExteriorPersistentRef.ToString(), fixture.DestinationPlugin));
        Assert.Equal("temporary", index.At(RecordRef.Effective).GetPlacement(fixture.ExteriorTemporaryRef.ToString(), fixture.DestinationPlugin)?.PlacementGroup);
    }

    // The requested record lands with its real fields and is not Partial Form; only the auto-created
    // WRLD ancestor is. The rival: an implementation that Partial-Forms everything in the minted
    // chain, including the record the caller asked to copy.
    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorCellItself_MintsWrldOverride_CellLandsOwnFieldsOnly()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.ExteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var index = fixture.Mirror.Index!;
        var worldspaceDoc = index.At(RecordRef.Effective).GetDocument(fixture.Worldspace.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(worldspaceDoc);
        Assert.True(worldspaceDoc!.IsPartialForm);

        var cellDoc = index.At(RecordRef.Effective).GetDocument(fixture.ExteriorCell.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(cellDoc);
        Assert.Equal(ContainerCopyFixture.ExteriorCellEditorId, cellDoc!.EditorId);
        Assert.False(cellDoc.IsPartialForm);

        // Own fields only: neither ref rides along with a plain (non-deep) copy of the Cell.
        Assert.Null(index.At(RecordRef.Effective).GetDocument(fixture.ExteriorPersistentRef.ToString(), fixture.DestinationPlugin));
        Assert.Null(index.At(RecordRef.Effective).GetDocument(fixture.ExteriorTemporaryRef.ToString(), fixture.DestinationPlugin));

        var expectedLocation = index.At(RecordRef.Effective).GetCellLocation(fixture.SourcePlugin, fixture.ExteriorCell.ToString());
        Assert.Equal(expectedLocation, index.At(RecordRef.Effective).GetCellLocation(fixture.DestinationPlugin, fixture.ExteriorCell.ToString()));
    }

    // MintExteriorCell's two rows never reached ReapplyFilter when this branch returned straight from
    // CopyRecordAsOverride. A brand-new row can newly match an active filter.
    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorCellItself_MakesTheCellAppearInAnActiveFilteredListing()
    {
        using var fixture = ContainerCopyFixture.Create();
        // Scoped to the destination plugin: the source already holds a "cell" row under this FormKey, so
        // an unscoped filter would match pre-copy and pass whether or not the new row was re-evaluated.
        fixture.Mirror.SetFilter($"SELECT form_key FROM cell WHERE plugin = '{ContainerCopyFixture.DestinationPluginName}'");
        var query = new RecordQuery(RecordTypes: ["cell"], Plugin: fixture.DestinationPlugin, Limit: 50, Offset: 0);
        var before = fixture.Mirror.Reads!.Search(query).Total;

        var result = ServiceFor(fixture.Mirror).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.ExteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var after = fixture.Mirror.Reads!.Search(query);
        Assert.Equal(before + 1, after.Total);
    }

    // Interior placement carries no gameplay meaning to compute, so a missing Cell override
    // auto-creates: bare fields (xEdit parity), Partial Form flagged (an mEdit-specific divergence),
    // the reference placed inside it.
    [Fact]
    public void CopyRecordAsOverride_OnAnInteriorPlacedReference_AutoCreatesTheCellAsPartialForm_WhenMissing()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.PersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var cellDoc = fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.InteriorCell.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(cellDoc);
        Assert.True(cellDoc!.IsPartialForm);

        // The destination has no other Cell yet, so exactly one RecordData.json under Cells/ exists —
        // no EditorID to search by (the auto-created cell is bare, per the contract above).
        var cellFile = Directory
            .EnumerateFiles(Path.Combine(fixture.DestinationSourceRoot, "Cells"), "RecordData.json", SearchOption.AllDirectories)
            .Single();
        Assert.DoesNotContain(
            $"\"WaterHeight\": {ContainerCopyFixture.InteriorCellWaterHeight:0.0}",
            File.ReadAllText(cellFile),
            StringComparison.Ordinal);
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, File.ReadAllText(cellFile), StringComparison.Ordinal);

        var childDoc = fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(fixture.PersistentRef.ToString(), fixture.DestinationPlugin);
        Assert.NotNull(childDoc);
    }
}
