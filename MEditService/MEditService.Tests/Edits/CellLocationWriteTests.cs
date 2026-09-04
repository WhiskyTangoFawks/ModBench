using MEditService.Core.Records;

namespace MEditService.Tests.Edits;

/// <summary>Every other writer of <c>cell_location</c> re-derives a TopCell's row from its parent's
/// document; an exterior cell reached through SubCells is never an embedded child.</summary>
public sealed class CellLocationWriteTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private const string SyntheticCellFormKey = "000801:ContainerFixture.esp";
    private const string SyntheticWorldspaceFormKey = "000802:ContainerFixture.esp";

    [Fact]
    public void CreateCellLocation_MakesTheRowReadableThroughGetCellLocation()
    {
        var index = _fixture.Mirror.Index!;
        var row = new CellLocationRow(
            SyntheticCellFormKey, SyntheticWorldspaceFormKey,
            BlockX: 3, BlockY: -2, SubX: 0, SubY: -1, GridX: 12, GridY: -5, IsInterior: false);

        index.CreateCellLocation(_fixture.Plugin, row);

        Assert.Equal(row, index.At(RecordRef.Effective).GetCellLocation(_fixture.Plugin, SyntheticCellFormKey));
    }

    // The rival: an implementation appending without first deleting any prior row for the same cell
    // passes the empty-table test above but duplicates on a second call, corrupting every reader of
    // this table.
    [Fact]
    public void CreateCellLocation_CalledTwiceForTheSameCell_ReplacesRatherThanDuplicates()
    {
        var index = _fixture.Mirror.Index!;
        index.CreateCellLocation(_fixture.Plugin, new CellLocationRow(
            SyntheticCellFormKey, SyntheticWorldspaceFormKey,
            BlockX: 3, BlockY: -2, SubX: 0, SubY: -1, GridX: 12, GridY: -5, IsInterior: false));

        var updated = new CellLocationRow(
            SyntheticCellFormKey, SyntheticWorldspaceFormKey,
            BlockX: 5, BlockY: 7, SubX: 1, SubY: 0, GridX: 20, GridY: 30, IsInterior: false);
        index.CreateCellLocation(_fixture.Plugin, updated);

        Assert.Equal(updated, index.At(RecordRef.Effective).GetCellLocation(_fixture.Plugin, SyntheticCellFormKey));
        var cells = index.At(RecordRef.Effective).GetWorldspaceCells(_fixture.Plugin, SyntheticWorldspaceFormKey);
        Assert.Single(cells);
    }
}
