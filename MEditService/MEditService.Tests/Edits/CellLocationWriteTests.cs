using MEditService.Core.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #549 Slice 1: <see cref="IRecordIndex.CreateCellLocation"/> — the missing copy-in write for a
/// cell's own <c>cell_location</c> row. Every existing writer of this table
/// (<c>DuckDbRecordIndex.RederiveContainmentForRecord</c>) only ever re-derives a
/// <c>Worldspace.TopCell</c>'s row from its parent's freshly-reserialized document; a genuine
/// exterior cell reached through <c>SubCells</c> is never that document's embedded child, so nothing
/// before this method could ever produce its row. Exercised against <see cref="ContainerModFixture"/>'s
/// real DuckDB-backed index, the same direct-index-seam posture <c>ContainmentRederivationTests</c> uses.
/// </summary>
public sealed class CellLocationWriteTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private const string SyntheticCellFormKey = "000801:ContainerFixture.esp";
    private const string SyntheticWorldspaceFormKey = "000802:ContainerFixture.esp";

    [Fact]
    public void CreateCellLocation_MakesTheRowReadableThroughGetCellLocation()
    {
        var index = _fixture.Sessions.Index!;
        var row = new CellLocationRow(
            SyntheticCellFormKey, SyntheticWorldspaceFormKey,
            BlockX: 3, BlockY: -2, SubX: 0, SubY: -1, GridX: 12, GridY: -5, IsInterior: false);

        index.CreateCellLocation(_fixture.Plugin, row);

        Assert.Equal(row, index.GetCellLocation(_fixture.Plugin, SyntheticCellFormKey));
    }

    // The rival this guards against: an implementation that appends without first deleting any prior
    // row for the same cell — passes the test above (empty table) but silently duplicates on a
    // second call (a retried or re-applied copy), which corrupts every COUNT/JOIN reader of this
    // table (GetWorldspaceCells) rather than merely returning a stale value.
    [Fact]
    public void CreateCellLocation_CalledTwiceForTheSameCell_ReplacesRatherThanDuplicates()
    {
        var index = _fixture.Sessions.Index!;
        index.CreateCellLocation(_fixture.Plugin, new CellLocationRow(
            SyntheticCellFormKey, SyntheticWorldspaceFormKey,
            BlockX: 3, BlockY: -2, SubX: 0, SubY: -1, GridX: 12, GridY: -5, IsInterior: false));

        var updated = new CellLocationRow(
            SyntheticCellFormKey, SyntheticWorldspaceFormKey,
            BlockX: 5, BlockY: 7, SubX: 1, SubY: 0, GridX: 20, GridY: 30, IsInterior: false);
        index.CreateCellLocation(_fixture.Plugin, updated);

        Assert.Equal(updated, index.GetCellLocation(_fixture.Plugin, SyntheticCellFormKey));
        var cells = index.GetWorldspaceCells(_fixture.Plugin, SyntheticWorldspaceFormKey);
        Assert.Single(cells);
    }
}
