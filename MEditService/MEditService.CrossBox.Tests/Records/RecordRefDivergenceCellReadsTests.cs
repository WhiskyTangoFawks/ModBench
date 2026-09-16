using MEditService.Index;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Records;

/// <summary>Each case renames rather than deletes: a delete would tear down the row's own
/// placement and cell-location rows, and the committed document would have no entry to hang
/// off.</summary>
public sealed class RecordRefDivergenceCellReadsTests
{
    [Fact]
    public void AWorldspaceCellRenamedInTheWorkingTree_KeepsItsCommittedEditorId_BesideTheNewOne()
    {
        using var fixture = new IndexedContainerFixture();
        fixture.Index.Settle();
        var index = fixture.Index.RequireReads();
        var before = index.GetDocument(fixture.TopCell.ToString(), fixture.Plugin).Require();

        fixture.Index.ProjectDocuments(
            fixture.Holder,
            fixture.Plugin,
            [(fixture.TopCell.ToString(),
              before.Body.Require().Replace(ContainerModFixture.TopCellEditorId, "RenamedTopCell", StringComparison.Ordinal))]);

        var effective = index.GetWorldspaceCells(fixture.Plugin, fixture.Worldspace.ToString())
            .Single(c => c.FormKey == fixture.TopCell.ToString());
        var head = index.HeadDocument(fixture.TopCell.ToString(), fixture.Plugin).Require();

        Assert.Equal("RenamedTopCell", effective.EditorId);
        Assert.Equal(ContainerModFixture.TopCellEditorId, head.EditorId);
    }

    [Fact]
    public void AnInteriorCellRenamedInTheWorkingTree_KeepsItsCommittedEditorId_BesideTheNewOne()
    {
        using var fixture = new IndexedContainerFixture();
        fixture.Index.Settle();
        var index = fixture.Index.RequireReads();
        var before = index.GetDocument(fixture.Cell.ToString(), fixture.Plugin).Require();

        fixture.Index.ProjectDocuments(
            fixture.Holder,
            fixture.Plugin,
            [(fixture.Cell.ToString(),
              before.Body.Require().Replace(ContainerModFixture.CellEditorId, "RenamedCell", StringComparison.Ordinal))]);

        var effective = index.GetInteriorCells(fixture.Plugin, 50, 0).Items
            .Single(c => c.FormKey == fixture.Cell.ToString());
        var head = index.HeadDocument(fixture.Cell.ToString(), fixture.Plugin).Require();

        Assert.Equal("RenamedCell", effective.EditorId);
        Assert.Equal(ContainerModFixture.CellEditorId, head.EditorId);
    }

    [Fact]
    public void APlacedReferenceRenamedInTheWorkingTree_KeepsItsCommittedEditorId_BesideTheNewOne()
    {
        using var fixture = new IndexedContainerFixture();
        fixture.Index.Settle();
        var index = fixture.Index.RequireReads();
        var before = index.GetDocument(fixture.TemporaryRef.ToString(), fixture.Plugin).Require();

        fixture.Index.ProjectDocuments(
            fixture.Holder,
            fixture.Plugin,
            [(fixture.TemporaryRef.ToString(),
              before.Body.Require().Replace(ContainerModFixture.TemporaryRefEditorId, "RenamedTempRef", StringComparison.Ordinal))]);

        var effective = index.GetCellReferences(fixture.Plugin, fixture.EmbedCell.ToString())
            .Temporary.Single(p => p.FormKey == fixture.TemporaryRef.ToString());
        var head = index.HeadDocument(fixture.TemporaryRef.ToString(), fixture.Plugin).Require();

        Assert.Equal("RenamedTempRef", effective.EditorId);
        Assert.Equal(ContainerModFixture.TemporaryRefEditorId, head.EditorId);
    }
}
