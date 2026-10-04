using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.Records;

public sealed class WorkingTreeRenamedCellReadsTests : IDisposable
{
    private readonly IndexedContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private void RenameRatherThanDeleteBecauseADeleteTearsDownPlacementAndCellLocationRows(string formKey, string from, string to)
    {
        var before = _fixture.Reads.DocumentOf(formKey, _fixture.Plugin).BodyOf();
        _fixture.Index.Project(_fixture.Entry, [(formKey, before.Replace(from, to, StringComparison.Ordinal))]);
    }

    [Fact]
    public void AWorldspaceCellRenamedInTheWorkingTree_ListsUnderTheNewEditorId()
    {
        var topCell = _fixture.TopCell;
        RenameRatherThanDeleteBecauseADeleteTearsDownPlacementAndCellLocationRows(topCell, ContainerModPlugin.TopCellEditorId, "RenamedTopCell");

        var effective = _fixture.Reads.GetWorldspaceCells(_fixture.Plugin, _fixture.Worldspace)
            .Single(c => c.FormKey == topCell);

        Assert.Equal("RenamedTopCell", effective.EditorId);
    }

    [Fact]
    public void AnInteriorCellRenamedInTheWorkingTree_ListsUnderTheNewEditorId()
    {
        var cell = _fixture.Cell;
        RenameRatherThanDeleteBecauseADeleteTearsDownPlacementAndCellLocationRows(cell, ContainerModPlugin.CellEditorId, "RenamedCell");

        var effective = _fixture.Reads.GetInteriorCells(_fixture.Plugin).Single(c => c.FormKey == cell);

        Assert.Equal("RenamedCell", effective.EditorId);
    }

    [Fact]
    public void APlacedReferenceRenamedInTheWorkingTree_ListsUnderTheNewEditorId()
    {
        var temporaryRef = _fixture.TemporaryRef;
        RenameRatherThanDeleteBecauseADeleteTearsDownPlacementAndCellLocationRows(temporaryRef, ContainerModPlugin.TemporaryRefEditorId, "RenamedTempRef");

        var effective = _fixture.Reads.GetCellChildRecords(_fixture.Plugin, _fixture.EmbedCell)
            .Temporary.Single(p => p.FormKey == temporaryRef);

        Assert.Equal("RenamedTempRef", effective.EditorId);
    }
}
