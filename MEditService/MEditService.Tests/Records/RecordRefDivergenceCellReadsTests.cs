using MEditService.Core.Records;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Records;

/// <summary>Each case renames rather than deletes: a delete would tear down the row's own
/// placement/cell_location row, collapsing the join's FROM side at Effective and passing whichever
/// relation is joined against.</summary>
public sealed class RecordRefDivergenceCellReadsTests
{
    [Fact]
    public void AtHead_GetWorldspaceCells_ShowsTheCommittedEditorId_WhenEffectiveWasRenamed()
    {
        using var fixture = new ContainerModFixture();
        fixture.Mirror.Settle();
        var index = fixture.Mirror.Index!;
        var before = index.At(RecordRef.Effective).GetDocument(fixture.TopCell.ToString(), fixture.Plugin)!;

        index.ProjectDocuments(
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
        fixture.Mirror.Settle();
        var index = fixture.Mirror.Index!;
        var before = index.At(RecordRef.Effective).GetDocument(fixture.Cell.ToString(), fixture.Plugin)!;

        index.ProjectDocuments(
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
        fixture.Mirror.Settle();
        var index = fixture.Mirror.Index!;
        var before = index.At(RecordRef.Effective).GetDocument(fixture.TemporaryRef.ToString(), fixture.Plugin)!;

        index.ProjectDocuments(
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
