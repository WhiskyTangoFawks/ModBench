using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

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
    public void APlacedRecordCreatedInAGridCell_OfAGameWithNoKnownCellWidth_IsRefusedNamingTheCell_AndKeepsTheBareDocument()
    {
        var placed = Document.Parse("""{ "FormKey": "000802:Holds.esm" }""");
        var cell = PlacedCell.WithGrid(Document.Parse("""{ "FormKey": "000801:Holds.esm" }"""), 3, -2);

        Assert.False(PlacedCell.TryAsCreatedIn(placed, PersistentFlag.TemporaryGroup, cell, GameRelease.Starfield, out var created, out var refusal));

        Assert.Equal(
            "000801:Holds.esm has a grid, and mEdit knows no cell width for Starfield to place a new reference at its centre.",
            refusal);
        Assert.Equal("""{"FormKey":"000802:Holds.esm"}""", created.Text);
    }
}
