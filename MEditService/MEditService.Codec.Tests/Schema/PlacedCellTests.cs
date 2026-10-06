using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class PlacedCellTests
{
    [Fact]
    public void APlacedRecordCreatedInAGridCell_OfAGameWithNoKnownCellWidth_IsNotPlaced_AndKeepsTheBareDocument()
    {
        var placed = new JsonObject { ["FormKey"] = "000801:Holds.esm" };
        var cell = new JsonObject { [RecordTypeDispatch.CellGridMember] = PlacedCell.GridAt(3, -2) };

        Assert.False(PlacedCell.TryAsCreatedIn(placed, PersistentFlag.TemporaryGroup, cell, GameRelease.Starfield));

        Assert.Equal("""{"FormKey":"000801:Holds.esm"}""", placed.ToJsonString());
    }
}
