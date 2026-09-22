using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceRepo;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A plain "Copy as Override" is own-fields-only for every record type, containers
/// included (xEdit parity: only "Deep copy as override" carries children).</summary>
public sealed class CopyRecordAsOverrideHandlerContainerTests
{
    [Fact]
    public void CopyRecordAsOverride_OnAQuest_Succeeds_OwnFieldsLand_ChildListsEmpty()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.Quest.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var document = fixture.Document(fixture.DestinationPlugin, fixture.Quest.ToString());
        Assert.NotNull(document);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, document.EditorId);

        // Own fields only — no child lands in the tree, and the quest's own document carries no child slot.
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.DialogTopic.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.Scene.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.DialogBranch.ToString()));
        var questText = File.ReadAllText(fixture.DestinationSourceFileContaining(ContainerCopyFixture.QuestEditorId));
        foreach (var slot in new[] { "DialogTopics", "DialogBranches", "Scenes" })
            Assert.DoesNotContain($"\"{slot}\"", questText, StringComparison.Ordinal);
    }

    // A Cell's own fields land, but its four embedded slots come back empty, not verbatim. Their
    // FormKeys never land as rows in the destination either, matching "empty child lists" literally.
    [Fact]
    public void CopyRecordAsOverride_OnAnInteriorCell_Succeeds_OwnFieldsLand_EmbeddedSlotsEmpty()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var document = fixture.Document(fixture.DestinationPlugin, fixture.InteriorCell.ToString());
        Assert.NotNull(document);
        Assert.Equal(ContainerCopyFixture.InteriorCellEditorId, document.EditorId);
        Assert.Contains(
            $"\"WaterHeight\": {ContainerCopyFixture.InteriorCellWaterHeight:0.0}",
            File.ReadAllText(fixture.DestinationSourceFileContaining(ContainerCopyFixture.InteriorCellEditorId)),
            StringComparison.Ordinal);

        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.PersistentRef.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.TemporaryRef.ToString()));

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

        var result = fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.Worldspace.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var document = fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString());
        Assert.NotNull(document);
        Assert.Equal(ContainerCopyFixture.WorldspaceEditorId, document.EditorId);

        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.TopCell.ToString()));
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
        var service = fixture.CopyAsOverrideHandler;
        Assert.True(service.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.InteriorCell.ToString(), fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.PersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var child = fixture.Document(fixture.DestinationPlugin, fixture.PersistentRef.ToString());
        Assert.NotNull(child);
        Assert.Equal(ContainerCopyFixture.PersistentRefEditorId, child.EditorId);

        var cellFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.InteriorCellEditorId);
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, File.ReadAllText(cellFile), StringComparison.Ordinal);
        // The negative control this copy must not touch: the reference never copied at all.
        Assert.DoesNotContain(ContainerCopyFixture.TemporaryRefEditorId, File.ReadAllText(cellFile), StringComparison.Ordinal);

        Assert.False(fixture.Document(fixture.DestinationPlugin, fixture.InteriorCell.ToString()).Require().IsPartialForm());
    }

    // A permanent boundary for a Worldspace's TopCell: its cell_location row carries no
    // block/sub/grid at all, so there is nothing for MintExteriorCell to place it at.
    [Fact]
    public void CopyRecordAsOverride_OnATopCellPlacedReference_Refuses_WhenDestinationHasNoCellOverride()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.TopCellRef.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerParentMissingInDestination, result.Refusal);
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.TopCellRef.ToString()));
    }

    // Copying the TopCell itself hits its own check (the isCell branch in CopyRecordAsOverride, not
    // the embedded-child path), so the placed-reference variant cannot stand in for it.
    [Fact]
    public void CopyRecordAsOverride_OnATopCellItself_Refuses()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.TopCell.ToString(), fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerParentMissingInDestination, result.Refusal);
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.TopCell.ToString()));
    }

    // The genuine SubCells exterior case. Both ancestors mint as bare Partial Forms; the REFR lands
    // with its real fields in the same slot the source has it in, and cell_location for the new cell
    // matches the source's row exactly.
    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorPlacedReference_MintsWrldAndCellOverrides_WhenDestinationHasNeither()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.ExteriorPersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        Assert.True(fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()).Require().IsPartialForm());

        var cell = fixture.Document(fixture.DestinationPlugin, fixture.ExteriorCell.ToString());
        Assert.NotNull(cell);
        Assert.True(cell.IsPartialForm());

        var placed = fixture.Document(fixture.DestinationPlugin, fixture.ExteriorPersistentRef.ToString());
        Assert.NotNull(placed);
        Assert.Equal(ContainerCopyFixture.ExteriorPersistentRefEditorId, placed.EditorId);

        var cellFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.ExteriorPersistentRefEditorId);
        var cellText = File.ReadAllText(cellFile);
        Assert.Contains(ContainerCopyFixture.ExteriorPersistentRefEditorId, cellText, StringComparison.Ordinal);
        // The negative control: the sibling temporary ref never copied, and never rode along.
        Assert.DoesNotContain(ContainerCopyFixture.ExteriorTemporaryRefEditorId, cellText, StringComparison.Ordinal);
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorTemporaryRef.ToString()));

        // Block and sub-block are the directories the mint wrote; the grid is a field the mint carries
        // into the bare ancestor's document, the only place a lone cell can hold it.
        Assert.Equal(
            new CellPlacement(
                fixture.Worldspace.ToString(),
                ContainerCopyFixture.ExteriorBlockX, ContainerCopyFixture.ExteriorBlockY,
                ContainerCopyFixture.ExteriorSubX, ContainerCopyFixture.ExteriorSubY, IsInterior: false),
            fixture.DestinationCellPlacement(fixture.ExteriorCell.ToString(), editorId: null));
        Assert.Contains(
            $"\"{ContainerCopyFixture.ExteriorGridX}, {ContainerCopyFixture.ExteriorGridY}\"",
            cell.Body, StringComparison.Ordinal);
    }

    // A tracked source's own tree is what says where its cell sits: the block levels are directories
    // there too, so the mint lands at the same coordinates an untracked source's file gives.
    [Fact]
    public void CopyRecordAsOverride_OnAnExteriorPlacedReferenceFromATrackedSource_MintsAtTheSourcesOwnBlock()
    {
        using var fixture = ContainerCopyFixture.CreateWithTrackedSource();

        var result = fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.ExteriorPersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        // The directory names the mint wrote, not a read back through the same layout reader that
        // supplied them: a reader that swapped the two levels would round-trip its own mistake.
        var worldspaceDirectory = Assert.Single(
            Directory.EnumerateDirectories(Path.Combine(fixture.DestinationSourceRoot, "Worldspaces")));
        var blockDirectory = Assert.Single(
            Directory.EnumerateDirectories(worldspaceDirectory),
            d => Path.GetFileName(d)
                .Equals($"{ContainerCopyFixture.ExteriorBlockX}, {ContainerCopyFixture.ExteriorBlockY}", StringComparison.Ordinal));
        Assert.Single(
            Directory.EnumerateDirectories(blockDirectory),
            d => Path.GetFileName(d)
                .Equals($"{ContainerCopyFixture.ExteriorSubX}, {ContainerCopyFixture.ExteriorSubY}", StringComparison.Ordinal));
        Assert.Contains(
            ContainerCopyFixture.ExteriorPersistentRefEditorId,
            File.ReadAllText(fixture.DestinationSourceFileContaining(ContainerCopyFixture.ExteriorPersistentRefEditorId)),
            StringComparison.Ordinal);
    }

    // "REFR in the same Persistent/Temporary slot as the source" — the
    // Temporary half, so an implementation that hardcodes the Persistent slot cannot pass.
    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorTemporaryPlacedReference_LandsInTheTemporarySlot()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.ExteriorTemporaryRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var cell = fixture.Document(fixture.DestinationPlugin, fixture.ExteriorCell.ToString());
        Assert.NotNull(cell);
        Assert.True(cell.IsPartialForm());
        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorTemporaryRef.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorPersistentRef.ToString()));

        // The slot itself, in the minted cell's own document: an implementation hardcoding Persistent
        // would land the ref in the other member.
        var slots = JsonDocument.Parse(cell.Body).RootElement;
        Assert.Equal(
            fixture.ExteriorTemporaryRef.ToString(),
            Assert.Single(slots.GetProperty("Temporary").EnumerateArray()).GetProperty("FormKey").GetString());
        Assert.False(slots.TryGetProperty("Persistent", out _));
    }

    // The requested record lands with its real fields and is not Partial Form; only the auto-created
    // WRLD ancestor is. The rival: an implementation that Partial-Forms everything in the minted
    // chain, including the record the caller asked to copy.
    [Fact]
    public void CopyRecordAsOverride_OnAGenuineExteriorCellItself_MintsWrldOverride_CellLandsOwnFieldsOnly()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.ExteriorCell.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        Assert.True(fixture.Document(fixture.DestinationPlugin, fixture.Worldspace.ToString()).Require().IsPartialForm());

        var cell = fixture.Document(fixture.DestinationPlugin, fixture.ExteriorCell.ToString());
        Assert.NotNull(cell);
        Assert.Equal(ContainerCopyFixture.ExteriorCellEditorId, cell.EditorId);
        Assert.False(cell.IsPartialForm());

        // Own fields only: neither ref rides along with a plain (non-deep) copy of the Cell.
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorPersistentRef.ToString()));
        Assert.Null(fixture.Document(fixture.DestinationPlugin, fixture.ExteriorTemporaryRef.ToString()));

        Assert.Equal(
            new CellPlacement(
                fixture.Worldspace.ToString(),
                ContainerCopyFixture.ExteriorBlockX, ContainerCopyFixture.ExteriorBlockY,
                ContainerCopyFixture.ExteriorSubX, ContainerCopyFixture.ExteriorSubY, IsInterior: false),
            fixture.DestinationCellPlacement(
                fixture.ExteriorCell.ToString(), ContainerCopyFixture.ExteriorCellEditorId));
    }

    // Interior placement carries no gameplay meaning to compute, so a missing Cell override
    // auto-creates: bare fields (xEdit parity), Partial Form flagged (an mEdit-specific divergence),
    // the reference placed inside it.
    [Fact]
    public void CopyRecordAsOverride_OnAnInteriorPlacedReference_AutoCreatesTheCellAsPartialForm_WhenMissing()
    {
        using var fixture = ContainerCopyFixture.Create();

        var result = fixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.PersistentRef.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var mintedCell = fixture.Document(fixture.DestinationPlugin, fixture.InteriorCell.ToString());
        Assert.NotNull(mintedCell);
        Assert.True(mintedCell.IsPartialForm());

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

        Assert.NotNull(fixture.Document(fixture.DestinationPlugin, fixture.PersistentRef.ToString()));
    }

    [Fact]
    public void CopyRecordAsOverride_OnAResponse_WhenDestinationAlreadyHoldsItsTopicEmbeddedInTheQuest_LandsAfterTheExistingResponseWithEveryOtherQuestByteUntouched()
    {
        using var fixture = ContainerCopyFixture.Create();
        var service = fixture.CopyAsOverrideHandler;
        Assert.True(service.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.Response2.ToString(), fixture.DestinationPlugin).Applied);

        var questFile = fixture.DestinationSourceFileContaining(ContainerCopyFixture.Response2EditorId);
        var before = JsonNode.Parse(File.ReadAllText(questFile)).Require();
        var topicBefore = Assert.Single(before["DialogTopics"].Require().AsArray()).Require().AsObject();
        var existingResponse = topicBefore["Responses"].Require()[0].Require().ToJsonString();
        topicBefore.Remove("Responses");

        var result = service.CopyRecordAsOverride(
            fixture.SourcePlugin, fixture.Response1.ToString(), fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var after = JsonNode.Parse(File.ReadAllText(questFile)).Require();
        var topicAfter = Assert.Single(after["DialogTopics"].Require().AsArray()).Require().AsObject();
        var responsesAfter = topicAfter["Responses"].Require().AsArray();

        Assert.Equal(2, responsesAfter.Count);
        Assert.Equal(existingResponse, responsesAfter[0].Require().ToJsonString());
        Assert.Equal(fixture.Response1.ToString(), responsesAfter[1].Require()["FormKey"].Require().GetValue<string>());

        topicAfter.Remove("Responses");
        Assert.Equal(before.ToJsonString(), after.ToJsonString());
    }
}
