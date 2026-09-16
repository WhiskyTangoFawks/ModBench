using MEditService.Index;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Records;

/// <summary>Each case renames rather than deletes: a delete would tear down the row's own
/// placement/cell_location row, collapsing the join's FROM side at Effective and passing whichever
/// relation is joined against.</summary>
public sealed class RecordRefDivergenceCellReadsTests
{
    private static IRecordIndex RequireStore(IndexProjector index) =>
        index.Store ?? throw new InvalidOperationException("Expected the index to hold a store.");

    private static RecordDocument RequireDocument(RecordDocument? document, string formKey) =>
        document ?? throw new InvalidOperationException($"Expected {formKey} to resolve to a document.");

    private static string RequireBody(RecordDocument document) =>
        document.Body ?? throw new InvalidOperationException($"Expected {document.FormKey}'s document to carry a body.");

    [Fact]
    public void AtHead_GetWorldspaceCells_ShowsTheCommittedEditorId_WhenEffectiveWasRenamed()
    {
        using var fixture = new IndexedContainerFixture();
        fixture.Index.Settle();
        var index = RequireStore(fixture.Index);
        var before = RequireDocument(index.At(RecordRef.Effective).GetDocument(fixture.TopCell.ToString(), fixture.Plugin), fixture.TopCell.ToString());

        index.ProjectDocuments(
            fixture.Plugin,
            [(fixture.TopCell.ToString(),
              RequireBody(before).Replace(ContainerModFixture.TopCellEditorId, "RenamedTopCell", StringComparison.Ordinal))]);

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
        using var fixture = new IndexedContainerFixture();
        fixture.Index.Settle();
        var index = RequireStore(fixture.Index);
        var before = RequireDocument(index.At(RecordRef.Effective).GetDocument(fixture.Cell.ToString(), fixture.Plugin), fixture.Cell.ToString());

        index.ProjectDocuments(
            fixture.Plugin,
            [(fixture.Cell.ToString(),
              RequireBody(before).Replace(ContainerModFixture.CellEditorId, "RenamedCell", StringComparison.Ordinal))]);

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
        using var fixture = new IndexedContainerFixture();
        fixture.Index.Settle();
        var index = RequireStore(fixture.Index);
        var before = RequireDocument(index.At(RecordRef.Effective).GetDocument(fixture.TemporaryRef.ToString(), fixture.Plugin), fixture.TemporaryRef.ToString());

        index.ProjectDocuments(
            fixture.Plugin,
            [(fixture.TemporaryRef.ToString(),
              RequireBody(before).Replace(ContainerModFixture.TemporaryRefEditorId, "RenamedTempRef", StringComparison.Ordinal))]);

        var effective = index.At(RecordRef.Effective).GetCellReferences(fixture.Plugin, fixture.EmbedCell.ToString())
            .Temporary.Single(p => p.FormKey == fixture.TemporaryRef.ToString());
        var head = index.At(RecordRef.Head).GetCellReferences(fixture.Plugin, fixture.EmbedCell.ToString())
            .Temporary.Single(p => p.FormKey == fixture.TemporaryRef.ToString());

        Assert.Equal("RenamedTempRef", effective.EditorId);
        Assert.Equal(ContainerModFixture.TemporaryRefEditorId, head.EditorId);
    }
}
