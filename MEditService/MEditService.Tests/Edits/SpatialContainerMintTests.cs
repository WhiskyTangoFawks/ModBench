using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>Every document the mint places is pinned to the byte, because the index stores what the
/// tree holds and the compiler reads the block levels back out of their directory names.</summary>
public sealed class SpatialContainerMintTests
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string DestinationPluginName = "Destination.esp";

    private const string WorldspaceFormKey = "000801:Source.esm";
    private const string CellFormKey = "000802:Source.esm";

    // Deliberately not derivable from a naive floor(grid/N)-style formula for this grid point — a
    // rival that recomputed block/sub-block instead of carrying the placement's own numbers through
    // would not reproduce these exact directory names.
    private static readonly CellPlacement Location =
        new(WorldspaceFormKey, BlockX: 3, BlockY: -2, SubX: 0, SubY: -1, IsInterior: false);

    private static string Lines(params string[] lines) => string.Join('\n', lines);

    private static readonly string WorldspaceDocument = Lines(
        "{",
        "  \"FormKey\": \"000801:Source.esm\",",
        "  \"MajorRecordFlagsRaw\": 16384,",
        "  \"Fallout4MajorRecordFlags\": [",
        "    \"0x4000\"",
        "  ],",
        "  \"MajorFlags\": [",
        "    \"0x4000\"",
        "  ]",
        "}");

    private static readonly string BlockDocument = Lines(
        "{",
        "  \"BlockNumberY\": -2,",
        "  \"BlockNumberX\": 3",
        "}");

    private static readonly string SubBlockDocument = Lines(
        "{",
        "  \"BlockNumberY\": -1",
        "}");

    private static readonly string CellDocument = Lines(
        "{",
        "  \"FormKey\": \"000802:Source.esm\",",
        "  \"MajorRecordFlagsRaw\": 16384,",
        "  \"Fallout4MajorRecordFlags\": [",
        "    \"0x4000\"",
        "  ],",
        "  \"Grid\": {",
        "    \"Point\": \"200, -199\"",
        "  },",
        "  \"MajorFlags\": [",
        "    \"0x4000\"",
        "  ]",
        "}");

    private static void Mint(string modFolder, string? existingWorldspaceDirectory)
    {
        var worldspace = (IMajorRecord)MajorRecordInstantiator.Activator(
            FormKey.Factory(WorldspaceFormKey), Release, typeof(Worldspace));
        worldspace.MajorRecordFlagsRaw |= PartialFormFlag.Bit;

        var cell = (IMajorRecord)MajorRecordInstantiator.Activator(
            FormKey.Factory(CellFormKey), Release, typeof(Cell));
        cell.MajorRecordFlagsRaw |= PartialFormFlag.Bit;

        // The bare ancestor carries no grid of its own; a distinct source cell stands in for the one
        // the real copy path reads back off the source plugin's own document.
        var sourceCell = (Cell)MajorRecordInstantiator.Activator(cell.FormKey, Release, typeof(Cell));
        sourceCell.Grid = new CellGrid { Point = new P2Int(200, -199) };

        SpatialContainerMint.Mint(
            new RecordTextCodec(NullLogger<RecordTextCodec>.Instance),
            new RecordCopy.Destination(
                SourceRepository.Over(modFolder, Release), new PluginKey(DestinationPluginName, "DestinationMod"), modFolder),
            Release, Location, worldspace, "wrld", cell, "cell", sourceCell, existingWorldspaceDirectory);
    }

    private static string WorldspacesIn(string modFolder) =>
        Path.Combine(modFolder, "source", DestinationPluginName, "Worldspaces");

    [Fact]
    public void Mint_PlacesTheWorldspaceItsTwoBlockLevelsAndTheCell_AndNothingElse()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-spatial-mint-test-").FullName;
        try
        {
            Mint(modFolder, existingWorldspaceDirectory: null);

            var worldspaceDirectory = Path.Combine(WorldspacesIn(modFolder), "000801_Source.esm");
            var blockDirectory = Path.Combine(worldspaceDirectory, "3, -2");
            var subBlockDirectory = Path.Combine(blockDirectory, "0, -1");
            var cellDirectory = Path.Combine(subBlockDirectory, "000802_Source.esm");

            Assert.Equal(WorldspaceDocument, File.ReadAllText(Path.Combine(worldspaceDirectory, "RecordData.json")));
            Assert.Equal(BlockDocument, File.ReadAllText(Path.Combine(blockDirectory, "GroupRecordData.json")));
            Assert.Equal(SubBlockDocument, File.ReadAllText(Path.Combine(subBlockDirectory, "GroupRecordData.json")));
            Assert.Equal(CellDocument, File.ReadAllText(Path.Combine(cellDirectory, "RecordData.json")));

            Assert.Equal(
                4,
                Directory.EnumerateFiles(Path.Combine(modFolder, "source"), "*", SearchOption.AllDirectories).Count());
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Mint_IntoAnExistingWorldspaceDirectory_LandsInsideItAndLeavesItsOwnDocumentAlone()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-spatial-mint-test-").FullName;
        try
        {
            var existing = Path.Combine(WorldspacesIn(modFolder), "RealWorld - 000801_Source.esm");
            Directory.CreateDirectory(existing);
            var existingDocument = Lines("{", "  \"FormKey\": \"000801:Source.esm\",", "  \"EditorID\": \"RealWorld\"", "}");
            File.WriteAllText(Path.Combine(existing, "RecordData.json"), existingDocument);

            Mint(modFolder, existing);

            Assert.Equal(existingDocument, File.ReadAllText(Path.Combine(existing, "RecordData.json")));
            Assert.Equal(existing, Assert.Single(Directory.EnumerateDirectories(WorldspacesIn(modFolder))));

            var subBlockDirectory = Path.Combine(existing, "3, -2", "0, -1");
            Assert.Equal(BlockDocument, File.ReadAllText(Path.Combine(existing, "3, -2", "GroupRecordData.json")));
            Assert.Equal(SubBlockDocument, File.ReadAllText(Path.Combine(subBlockDirectory, "GroupRecordData.json")));
            Assert.Equal(
                CellDocument,
                File.ReadAllText(Path.Combine(subBlockDirectory, "000802_Source.esm", "RecordData.json")));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
