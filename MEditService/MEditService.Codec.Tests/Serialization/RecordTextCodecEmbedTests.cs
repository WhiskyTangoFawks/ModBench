using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Codec.Tests.Serialization;

public sealed class RecordTextCodecEmbedTests
{
    private static readonly Fallout4Mod Mod = new(ModKey.FromFileName("Embed.esp"), Fallout4Release.Fallout4);


    private static string[] EditorIds(JsonElement slot) =>
        [.. slot.EnumerateArray().Select(e => e.GetProperty("EditorID").GetString()
            ?? throw new InvalidOperationException("Expected a placed child to carry its EditorID."))];

    private static Cell MakePopulatedCell()
    {
        var cell = new Cell(Mod) { EditorID = "EmbedCell", Grid = new CellGrid { Point = new P2Int(1, 2) } };
        cell.Persistent.Add(new PlacedObject(Mod) { EditorID = "PersistentRef" });
        cell.Temporary.Add(new PlacedObject(Mod) { EditorID = "TemporaryRef" });
        cell.NavigationMeshes.Add(new NavigationMesh(Mod) { EditorID = "CellNavmesh" });
        cell.Landscape = new Landscape(Mod) { EditorID = "CellLandscape" };
        return cell;
    }

    [Fact]
    public void SerializeToText_ForAPopulatedCell_EmbedsEveryChildSlot()
    {
        var text = RecordTextCodec.SerializeToText(MakePopulatedCell(), GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement;

        Assert.Equal(
            ["PersistentRef"],
            root.GetProperty("Persistent").EnumerateArray().Select(e => JsonStrings.Of(e.GetProperty("EditorID"))).ToArray());
        Assert.Equal(
            ["TemporaryRef"],
            root.GetProperty("Temporary").EnumerateArray().Select(e => JsonStrings.Of(e.GetProperty("EditorID"))).ToArray());
        Assert.Equal(
            ["CellNavmesh"],
            root.GetProperty("NavigationMeshes").EnumerateArray().Select(e => JsonStrings.Of(e.GetProperty("EditorID"))).ToArray());
        Assert.Equal("CellLandscape", root.GetProperty("Landscape").GetProperty("EditorID").GetString());
    }

    [Fact]
    public void RoundTrip_OfAnEmbeddedCell_IsChildFaithful_WithTheParentsOwnFieldsUntouchedSoEmbedsChildrenNeverReadsAsSerializesChildrenInsteadOfItself()
    {

        var roundTripped = ReadBack.Of(MakePopulatedCell(), GameRelease.Fallout4, "cell");

        Assert.Equal(["PersistentRef"], EditorIds(roundTripped.GetProperty("Persistent")));
        Assert.Equal(["TemporaryRef"], EditorIds(roundTripped.GetProperty("Temporary")));
        Assert.Equal(["CellNavmesh"], EditorIds(roundTripped.GetProperty("NavigationMeshes")));
        Assert.Equal("CellLandscape", roundTripped.GetProperty("Landscape").GetProperty("EditorID").GetString());

        Assert.Equal("EmbedCell", roundTripped.GetProperty("EditorID").GetString());
        Assert.Equal("1, 2", roundTripped.GetProperty("Grid").GetProperty("Point").GetString());
    }

    [Fact]
    public void SerializeToText_ForAWorldspace_EmbedsItsTopCell()
    {
        var worldspace = new Worldspace(Mod)
        {
            EditorID = "EmbedWorldspace",
            TopCell = new Cell(Mod) { EditorID = "EmbedTopCell" },
        };

        var text = RecordTextCodec.SerializeToText(worldspace, GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(text);
        Assert.Equal("EmbedTopCell", doc.RootElement.GetProperty("TopCell").GetProperty("EditorID").GetString());
    }
}
