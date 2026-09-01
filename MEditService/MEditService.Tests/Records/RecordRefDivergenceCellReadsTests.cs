using MEditService.Core.Records;
using MEditService.Tests.Edits;

namespace MEditService.Tests.Records;

/// <summary>
/// The three placement/cell-table-backed twins (<c>GetWorldspaceCells</c>,
/// <c>GetInteriorCells</c>, <c>GetCellReferences</c>) at their
/// <see cref="IRecordIndex.At"/>(<see cref="RecordRef.Head"/>) path
/// — every other call site (<c>RegistrationScopingTests</c>,
/// <c>RecordEditServiceContainerDeleteRenumberTests</c>) exercises them at Effective only. Sibling of
/// <see cref="RecordRefDivergenceTests"/>'s own five aggregate-read cases, split into its own file
/// because these three need <see cref="ContainerModFixture"/>'s cell/worldspace/placed-ref shapes
/// rather than the flat-NPC fixture the others share.
///
/// <para>Each case renames (not deletes) the record the join's display columns come from: a delete
/// would also tear down the row's own <c>placement</c>/<c>cell_location</c> row
/// (<c>DeleteContainmentForRecord</c>), collapsing the join's <i>FROM</i> side at Effective and making
/// the case pass regardless of which relation is joined against — the exact vacuity a rename avoids,
/// since <c>editor_id</c> is a projection of the body (<c>UpsertEffectiveBody</c>) while the
/// structural side table is untouched by an ordinary field edit.</para>
/// </summary>
public sealed class RecordRefDivergenceCellReadsTests
{
    [Fact]
    public void AtHead_GetWorldspaceCells_ShowsTheCommittedEditorId_WhenEffectiveWasRenamed()
    {
        using var fixture = new ContainerModFixture();
        var index = fixture.Mirror.Index!;
        var before = index.At(RecordRef.Effective).GetDocument(fixture.TopCell.ToString(), fixture.Plugin)!;

        index.ApplyWorkingTreeChanges(
            fixture.Plugin,
            [(fixture.TopCell.ToString(),
              before.Body!.Replace(ContainerModFixture.TopCellEditorId, "RenamedTopCell", StringComparison.Ordinal))]);

        var effective = index.At(RecordRef.Effective).GetWorldspaceCells(fixture.Plugin, fixture.Worldspace.ToString())
            .Single(c => c.FormKey == fixture.TopCell.ToString());
        var head = index.At(RecordRef.Head).GetWorldspaceCells(fixture.Plugin, fixture.Worldspace.ToString())
            .Single(c => c.FormKey == fixture.TopCell.ToString());

        Assert.Equal("RenamedTopCell", effective.EditorId);
        Assert.Equal(ContainerModFixture.TopCellEditorId, head.EditorId);
    }

    [Fact]
    public void AtHead_GetInteriorCells_ShowsTheCommittedEditorId_WhenEffectiveWasRenamed()
    {
        using var fixture = new ContainerModFixture();
        var index = fixture.Mirror.Index!;
        var before = index.At(RecordRef.Effective).GetDocument(fixture.Cell.ToString(), fixture.Plugin)!;

        index.ApplyWorkingTreeChanges(
            fixture.Plugin,
            [(fixture.Cell.ToString(),
              before.Body!.Replace(ContainerModFixture.CellEditorId, "RenamedCell", StringComparison.Ordinal))]);

        var effective = index.At(RecordRef.Effective).GetInteriorCells(fixture.Plugin, 50, 0).Items
            .Single(c => c.FormKey == fixture.Cell.ToString());
        var head = index.At(RecordRef.Head).GetInteriorCells(fixture.Plugin, 50, 0).Items
            .Single(c => c.FormKey == fixture.Cell.ToString());

        Assert.Equal("RenamedCell", effective.EditorId);
        Assert.Equal(ContainerModFixture.CellEditorId, head.EditorId);
    }

    [Fact]
    public void AtHead_GetCellReferences_ShowsTheCommittedEditorId_WhenEffectiveWasRenamed()
    {
        using var fixture = new ContainerModFixture();
        var index = fixture.Mirror.Index!;
        var before = index.At(RecordRef.Effective).GetDocument(fixture.TemporaryRef.ToString(), fixture.Plugin)!;

        index.ApplyWorkingTreeChanges(
            fixture.Plugin,
            [(fixture.TemporaryRef.ToString(),
              before.Body!.Replace(ContainerModFixture.TemporaryRefEditorId, "RenamedTempRef", StringComparison.Ordinal))]);

        var effective = index.At(RecordRef.Effective).GetCellReferences(fixture.Plugin, fixture.EmbedCell.ToString())
            .Temporary.Single(p => p.FormKey == fixture.TemporaryRef.ToString());
        var head = index.At(RecordRef.Head).GetCellReferences(fixture.Plugin, fixture.EmbedCell.ToString())
            .Temporary.Single(p => p.FormKey == fixture.TemporaryRef.ToString());

        Assert.Equal("RenamedTempRef", effective.EditorId);
        Assert.Equal(ContainerModFixture.TemporaryRefEditorId, head.EditorId);
    }
}
