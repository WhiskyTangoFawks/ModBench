using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class PlacedCellTests
{
    [Fact]
    public void APlacedRecordCreatedInAGridCell_OfAGameWithNoKnownCellWidth_IsRefusedNamingTheCell_AndKeepsTheBareDocument()
    {
        var placed = new JsonObject { [RecordMembers.FormKey] = "000802:Holds.esm" };
        var cell = new JsonObject
        {
            [RecordMembers.FormKey] = "000801:Holds.esm",
            [RecordTypeDispatch.CellGridMember] = PlacedCell.GridAt(3, -2),
        };

        Assert.False(PlacedCell.TryAsCreatedIn(placed, PersistentFlag.TemporaryGroup, cell, GameRelease.Starfield, out var refusal));

        Assert.Equal(
            "000801:Holds.esm has a grid, and mEdit knows no cell width for Starfield to place a new reference at its centre.",
            refusal);
        Assert.Equal("""{"FormKey":"000802:Holds.esm"}""", placed.ToJsonString());
    }
}
