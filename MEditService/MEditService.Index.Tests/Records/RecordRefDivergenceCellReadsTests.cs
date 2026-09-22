using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Index.Tests.Records;

/// <summary>Each case renames rather than deletes: a delete would tear down the row's own
/// placement and cell-location rows, and the committed document would have no entry to hang
/// off.</summary>
public sealed class RecordRefDivergenceCellReadsTests : IDisposable
{
    private readonly IndexedContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private void RenameInTheWorkingTree(string formKey, string from, string to)
    {
        var before = _fixture.Reads.DocumentOf(formKey, _fixture.Plugin).BodyOf();
        _fixture.Index.Project(_fixture.Entry, [(formKey, before.Replace(from, to, StringComparison.Ordinal))]);
    }

    [Fact]
    public void AWorldspaceCellRenamedInTheWorkingTree_KeepsItsCommittedEditorId_BesideTheNewOne()
    {
        var topCell = _fixture.TopCell;
        RenameInTheWorkingTree(topCell, ContainerModPlugin.TopCellEditorId, "RenamedTopCell");

        var effective = _fixture.Reads.GetWorldspaceCells(_fixture.Plugin, _fixture.Worldspace)
            .Single(c => c.FormKey == topCell);
        var head = _fixture.Reads.HeadDocument(topCell, _fixture.Plugin);

        Assert.Equal("RenamedTopCell", effective.EditorId);
        Assert.NotNull(head);
        Assert.Equal(ContainerModPlugin.TopCellEditorId, head.EditorId);
    }

    [Fact]
    public void AnInteriorCellRenamedInTheWorkingTree_KeepsItsCommittedEditorId_BesideTheNewOne()
    {
        var cell = _fixture.Cell;
        RenameInTheWorkingTree(cell, ContainerModPlugin.CellEditorId, "RenamedCell");

        var effective = _fixture.Reads.GetInteriorCells(_fixture.Plugin, 50, 0).Items.Single(c => c.FormKey == cell);
        var head = _fixture.Reads.HeadDocument(cell, _fixture.Plugin);

        Assert.Equal("RenamedCell", effective.EditorId);
        Assert.NotNull(head);
        Assert.Equal(ContainerModPlugin.CellEditorId, head.EditorId);
    }

    [Fact]
    public void APlacedReferenceRenamedInTheWorkingTree_KeepsItsCommittedEditorId_BesideTheNewOne()
    {
        var temporaryRef = _fixture.TemporaryRef;
        RenameInTheWorkingTree(temporaryRef, ContainerModPlugin.TemporaryRefEditorId, "RenamedTempRef");

        var effective = _fixture.Reads.GetCellReferences(_fixture.Plugin, _fixture.EmbedCell)
            .Temporary.Single(p => p.FormKey == temporaryRef);
        var head = _fixture.Reads.HeadDocument(temporaryRef, _fixture.Plugin);

        Assert.Equal("RenamedTempRef", effective.EditorId);
        Assert.NotNull(head);
        Assert.Equal(ContainerModPlugin.TemporaryRefEditorId, head.EditorId);
    }
}
