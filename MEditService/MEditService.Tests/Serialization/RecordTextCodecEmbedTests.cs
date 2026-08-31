using System.Text.Json;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Serialization;

/// <summary>
/// #450 S1 (ADR-0041's #444 amendment): the codec adopts Spriggit's embed customization verbatim —
/// <c>Cell.{Temporary,Persistent,Landscape,NavigationMeshes}</c> and <c>Worldspace.TopCell</c>
/// serialize <b>inline</b>, in the container's own document, rather than into child folders.
/// See <see cref="CellEmbedCustomization"/>/<see cref="WorldspaceEmbedCustomization"/> for the source it mirrors.
/// </summary>
public sealed class RecordTextCodecEmbedTests
{
    private static readonly Fallout4Mod Mod = new(ModKey.FromFileName("Embed.esp"), Fallout4Release.Fallout4);

    private static RecordTextCodec Codec() => new(NullLogger<RecordTextCodec>.Instance);

    private static Cell MakePopulatedCell()
    {
        var cell = new Cell(Mod) { EditorID = "EmbedCell", Grid = new CellGrid { Point = new P2Int(1, 2) } };
        cell.Persistent.Add(new PlacedObject(Mod) { EditorID = "PersistentRef" });
        cell.Temporary.Add(new PlacedObject(Mod) { EditorID = "TemporaryRef" });
        cell.NavigationMeshes.Add(new NavigationMesh(Mod) { EditorID = "CellNavmesh" });
        cell.Landscape = new Landscape(Mod) { EditorID = "CellLandscape" };
        return cell;
    }

    /// <summary>
    /// The four Cell child slots land in the cell's own document. Before the embed customization,
    /// the three <i>list</i> slots (Persistent/Temporary/NavigationMeshes) were written to per-child
    /// streams instead and discarded, so they were absent from these bytes entirely.
    /// </summary>
    [Fact]
    public async Task SerializeToBytesAsync_ForAPopulatedCell_EmbedsEveryChildSlot()
    {
        var bytes = await Codec().SerializeToBytesAsync(MakePopulatedCell(), GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        var root = doc.RootElement;

        Assert.Equal(
            ["PersistentRef"],
            root.GetProperty("Persistent").EnumerateArray().Select(e => e.GetProperty("EditorID").GetString()!).ToArray());
        Assert.Equal(
            ["TemporaryRef"],
            root.GetProperty("Temporary").EnumerateArray().Select(e => e.GetProperty("EditorID").GetString()!).ToArray());
        Assert.Equal(
            ["CellNavmesh"],
            root.GetProperty("NavigationMeshes").EnumerateArray().Select(e => e.GetProperty("EditorID").GetString()!).ToArray());
        Assert.Equal("CellLandscape", root.GetProperty("Landscape").GetProperty("EditorID").GetString());
    }

    /// <summary>AC3: an embedded cell round-trips with its children intact — the shallow-strip
    /// posture this replaces returned them empty/null by design.</summary>
    [Fact]
    public async Task RoundTrip_OfAnEmbeddedCell_IsChildFaithful()
    {
        var codec = Codec();
        var bytes = await codec.SerializeToBytesAsync(MakePopulatedCell(), GameRelease.Fallout4);

        var roundTripped = (Cell)await codec.DeserializeFromBytesAsync(bytes, GameRelease.Fallout4, "cell");

        Assert.Equal(["PersistentRef"], roundTripped.Persistent.Select(p => p.EditorID!).ToArray());
        Assert.Equal(["TemporaryRef"], roundTripped.Temporary.Select(p => p.EditorID!).ToArray());
        Assert.Equal(["CellNavmesh"], roundTripped.NavigationMeshes.Select(n => n.EditorID!).ToArray());
        Assert.Equal("CellLandscape", roundTripped.Landscape?.EditorID);

        // The parent's own fields are untouched by the embed — "embeds children" must not read as
        // "serializes children instead of itself".
        Assert.Equal("EmbedCell", roundTripped.EditorID);
        Assert.Equal(new P2Int(1, 2), roundTripped.Grid!.Point);
    }

    /// <summary>
    /// Embedding is what makes "one source unit = one file" true for a container: the cell's whole
    /// content is its own file, with no sibling <c>Persistent/</c>/<c>Temporary/</c> folders — the
    /// same layout claim <c>ContainerShallowVendoringTests</c> made for the stripped shape, now
    /// holding for the populated one.
    /// </summary>
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
    public async Task SerializeToBytesAsync_ForAWorldspace_EmbedsItsTopCell()
    {
        var worldspace = new Worldspace(Mod)
        {
            EditorID = "EmbedWorldspace",
            TopCell = new Cell(Mod) { EditorID = "EmbedTopCell" },
        };

        var bytes = await Codec().SerializeToBytesAsync(worldspace, GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        Assert.Equal("EmbedTopCell", doc.RootElement.GetProperty("TopCell").GetProperty("EditorID").GetString());
    }
}
