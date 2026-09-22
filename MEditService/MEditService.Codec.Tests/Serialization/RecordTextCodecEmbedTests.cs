using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Codec.Tests.Serialization;

/// <summary>The codec adopts Spriggit's embed customization verbatim (ADR-0007): the five embedded
/// slots serialize inline in the container's own document.</summary>
public sealed class RecordTextCodecEmbedTests
{
    private static readonly Fallout4Mod Mod = new(ModKey.FromFileName("Embed.esp"), Fallout4Release.Fallout4);

    private static RecordTextCodec Codec() => new(NullLogger<RecordTextCodec>.Instance);

    private static string RequireEditorID(IMajorRecordGetter record) =>
        record.EditorID ?? throw new InvalidOperationException($"Expected '{record.FormKey}' to have an EditorID.");

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
    public void SerializeToBytes_ForAPopulatedCell_EmbedsEveryChildSlot()
    {
        var bytes = Codec().SerializeToBytes(MakePopulatedCell(), GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        var root = doc.RootElement;

        Assert.Equal(
            ["PersistentRef"],
            root.GetProperty("Persistent").EnumerateArray().Select(e => DocumentNodes.StringValueOf(e.GetProperty("EditorID"))).ToArray());
        Assert.Equal(
            ["TemporaryRef"],
            root.GetProperty("Temporary").EnumerateArray().Select(e => DocumentNodes.StringValueOf(e.GetProperty("EditorID"))).ToArray());
        Assert.Equal(
            ["CellNavmesh"],
            root.GetProperty("NavigationMeshes").EnumerateArray().Select(e => DocumentNodes.StringValueOf(e.GetProperty("EditorID"))).ToArray());
        Assert.Equal("CellLandscape", root.GetProperty("Landscape").GetProperty("EditorID").GetString());
    }

    [Fact]
    public void RoundTrip_OfAnEmbeddedCell_IsChildFaithful()
    {
        var codec = Codec();
        var bytes = codec.SerializeToBytes(MakePopulatedCell(), GameRelease.Fallout4);

        var roundTripped = (Cell)codec.DeserializeFromBytes(bytes, GameRelease.Fallout4, "cell");

        Assert.Equal(["PersistentRef"], roundTripped.Persistent.Select(RequireEditorID).ToArray());
        Assert.Equal(["TemporaryRef"], roundTripped.Temporary.Select(RequireEditorID).ToArray());
        Assert.Equal(["CellNavmesh"], roundTripped.NavigationMeshes.Select(RequireEditorID).ToArray());
        Assert.Equal("CellLandscape", roundTripped.Landscape?.EditorID);

        // The parent's own fields are untouched by the embed — "embeds children" must not read as
        // "serializes children instead of itself".
        Assert.Equal("EmbedCell", roundTripped.EditorID);
        var grid = roundTripped.Grid ?? throw new InvalidOperationException("Expected the round-tripped cell to keep its grid.");
        Assert.Equal(new P2Int(1, 2), grid.Point);
    }

    [Fact]
    public async Task SerializeAsync_ForAPopulatedCell_WritesExactlyOneFile()
    {
        var dir = Directory.CreateTempSubdirectory("medit-embed-cell-");
        try
        {
            var filePath = Path.Combine(dir.FullName, "cell.json");
            await Codec().SerializeAsync(MakePopulatedCell(), filePath, GameRelease.Fallout4);

            Assert.Equal([filePath], Directory.GetFiles(dir.FullName, "*", SearchOption.AllDirectories));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public void SerializeToBytes_ForAWorldspace_EmbedsItsTopCell()
    {
        var worldspace = new Worldspace(Mod)
        {
            EditorID = "EmbedWorldspace",
            TopCell = new Cell(Mod) { EditorID = "EmbedTopCell" },
        };

        var bytes = Codec().SerializeToBytes(worldspace, GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        Assert.Equal("EmbedTopCell", doc.RootElement.GetProperty("TopCell").GetProperty("EditorID").GetString());
    }
}
