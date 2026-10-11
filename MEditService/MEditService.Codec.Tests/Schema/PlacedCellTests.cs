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

    private static readonly FormKey Placed = FormKey.Factory("000802:Holds.esm");

    public static TheoryData<GameRelease, string, int, int> PlacedAt => new()
    {
        {
            GameRelease.Starfield,
            RecordTextCodec.SerializeToText(
                new Mutagen.Bethesda.Starfield.PlacedObject(Placed, Mutagen.Bethesda.Starfield.StarfieldRelease.Starfield) { Position = new P3Float(232.9f, -18.9f, 242.4f) },
                GameRelease.Starfield),
            2, -1
        },
        {
            GameRelease.SkyrimSE,
            RecordTextCodec.SerializeToText(
                new PlacedObject(Placed, SkyrimRelease.SkyrimSE) { Placement = new Placement { Position = new P3Float(5000, -100, 0) } },
                GameRelease.SkyrimSE),
            1, -1
        },
    };

    [Theory]
    [MemberData(nameof(PlacedAt))]
    public void APlacedRecordsPosition_FallsInTheGridCellOfItsGamesWidth(GameRelease release, string placed, int x, int y) =>
        Assert.Equal((x, y), PlacedCell.GridHolding(Document.Parse(placed), release));

    public static TheoryData<GameRelease, string, string[], string> CreatedBare => new()
    {
        {
            GameRelease.Starfield,
            RecordTextCodec.SerializeToText(new Mutagen.Bethesda.Starfield.PlacedObject(Placed, Mutagen.Bethesda.Starfield.StarfieldRelease.Starfield), GameRelease.Starfield),
            ["Position"],
            "350, -150, 0"
        },
        {
            GameRelease.SkyrimSE,
            RecordTextCodec.SerializeToText(new PlacedObject(Placed, SkyrimRelease.SkyrimSE), GameRelease.SkyrimSE),
            ["Placement", "Position"],
            "14336, -6144, 0"
        },
    };

    [Theory]
    [MemberData(nameof(CreatedBare))]
    public void AReferenceCreatedInAGridCell_StartsAtItsCentre_WhereTheCodecReadsItsPosition(
        GameRelease release, string bare, string[] positionPath, string centre)
    {
        var cell = PlacedCell.WithGrid(Document.Parse("""{ "FormKey": "000801:Holds.esm" }"""), 3, -2);

        var created = PlacedCell.AsCreatedIn(Document.Parse(bare), PersistentFlag.TemporaryGroup, cell, release);

        var read = JsonNode.Parse(RecordTextCodec.RoundTrip(created.Text, release, "refr")).Require();
        Assert.Equal(centre, positionPath.Aggregate(read, (node, member) => node[member].Require()).GetValue<string>());
    }
}
