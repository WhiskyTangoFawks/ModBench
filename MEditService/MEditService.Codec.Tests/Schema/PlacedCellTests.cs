using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Skyrim;
using Noggog;

namespace MEditService.Codec.Tests.Schema;

public sealed class PlacedCellTests
{
    [Theory]
    [InlineData("""{ "Grid": { "Point": "3, -2" } }""", 3, -2)]
    [InlineData("""{ "Grid": {} }""", 0, 0)]
    public void ACellsGrid_IsThePointItsTextSpells_AndTheOriginWhereItsGridOmitsThePoint(string text, int x, int y)
    {
        Assert.Equal((x, y), Cell(text).Grid);
    }

    [Theory]
    [InlineData("1.5, 2")]
    [InlineData("x, y")]
    [InlineData("3")]
    public void ACellsGrid_ThatIsNoPairOfWholeNumbers_IsNone(string point)
    {
        Assert.Null(Cell($$"""{ "Grid": { "Point": "{{point}}" } }""").Grid);
    }

    [Fact]
    public void ACellWhoseTextCarriesNoGrid_HasNone()
    {
        Assert.Null(Cell("""{ "FormKey": "000801:Holds.esm" }""").Grid);
    }

    private static Document Cell(string text) => Document.Parse(text);

    [Fact]
    public void AStarfieldPlacedRecordsPosition_FallsInTheGridCellOfAHundredUnitsItNames()
    {
        var placed = new Mutagen.Bethesda.Starfield.PlacedObject(FormKey.Factory("000802:Holds.esm"), Mutagen.Bethesda.Starfield.StarfieldRelease.Starfield)
        {
            Position = new P3Float(232.9f, -18.9f, 242.4f),
        };

        Assert.Equal((2, -1), PlacedCell.GridHolding(Document.Parse(RecordTextCodec.SerializeToText(placed, GameRelease.Starfield)), GameRelease.Starfield));
    }

    [Fact]
    public void AReferenceCreatedInAStarfieldGridCell_StartsAtItsCentre()
    {
        var bare = Document.Parse(RecordTextCodec.SerializeToText(
            new Mutagen.Bethesda.Starfield.PlacedObject(FormKey.Factory("000802:Holds.esm"), Mutagen.Bethesda.Starfield.StarfieldRelease.Starfield), GameRelease.Starfield));
        var cell = PlacedCell.WithGrid(Document.Parse("""{ "FormKey": "000801:Holds.esm" }"""), 3, -2);

        Assert.True(PlacedCell.TryAsCreatedIn(bare, PersistentFlag.TemporaryGroup, cell, GameRelease.Starfield, out var created, out _));

        var read = JsonNode.Parse(RecordTextCodec.RoundTrip(created.Text, GameRelease.Starfield, "refr")).Require();
        Assert.Equal("350, -150, 0", read["Position"].Require().GetValue<string>());
    }

    [Fact]
    public void ASkyrimPlacedRecordsPosition_FallsInTheGridCellItsPlacementNames()
    {
        var placed = new PlacedObject(FormKey.Factory("000802:Holds.esm"), SkyrimRelease.SkyrimSE)
        {
            Placement = new Placement { Position = new P3Float(5000, -100, 0) },
        };

        Assert.Equal((1, -1), PlacedCell.GridHolding(Document.Parse(RecordTextCodec.SerializeToText(placed, GameRelease.SkyrimSE)), GameRelease.SkyrimSE));
    }

    [Fact]
    public void AReferenceCreatedInASkyrimGridCell_StartsAtItsCentre_InThePlacementTheCodecReads()
    {
        var bare = Document.Parse(RecordTextCodec.SerializeToText(new PlacedObject(FormKey.Factory("000802:Holds.esm"), SkyrimRelease.SkyrimSE), GameRelease.SkyrimSE));
        var cell = PlacedCell.WithGrid(Document.Parse("""{ "FormKey": "000801:Holds.esm" }"""), 3, -2);

        Assert.True(PlacedCell.TryAsCreatedIn(bare, PersistentFlag.TemporaryGroup, cell, GameRelease.SkyrimSE, out var created, out _));

        var read = JsonNode.Parse(RecordTextCodec.RoundTrip(created.Text, GameRelease.SkyrimSE, "refr")).Require();
        Assert.Equal("14336, -6144, 0", read["Placement"].Require()["Position"].Require().GetValue<string>());
    }
}
