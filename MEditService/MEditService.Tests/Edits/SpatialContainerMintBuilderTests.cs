using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;
using Noggog;
using Noggog.WorkEngine;

namespace MEditService.Tests.Edits;

public sealed class SpatialContainerMintBuilderTests
{
    private static readonly PluginKey DestinationPlugin = new("Destination.esp", "DestinationMod");

    [Fact]
    public async Task BuildSyntheticWorldspaceMod_ThenSerializeWholeMod_WritesBlockAndSubBlockFoldersNamedFromCellLocation()
    {
        var worldspace = (IMajorRecord)MajorRecordInstantiator.Activator(
            FormKey.Factory("000801:Source.esm"), GameRelease.Fallout4, typeof(Worldspace));
        worldspace.MajorRecordFlagsRaw |= PartialFormFlag.Bit;

        var cell = (IMajorRecord)MajorRecordInstantiator.Activator(
            FormKey.Factory("000802:Source.esm"), GameRelease.Fallout4, typeof(Cell));
        cell.MajorRecordFlagsRaw |= PartialFormFlag.Bit;

        // The bare ancestor carries no grid of its own; a distinct source cell stands in for the one
        // the real copy path reads back off the source plugin's own document.
        var sourceCell = (Cell)MajorRecordInstantiator.Activator(
            cell.FormKey, GameRelease.Fallout4, typeof(Cell));
        sourceCell.Grid = new CellGrid { Point = new P2Int(200, -199) };

        // Deliberately not derivable from a naive floor(grid/N)-style formula for this grid point —
        // a rival that recomputed block/sub-block instead of copying the placement's own numbers
        // through would not reproduce these exact values.
        var cellLocation = new CellPlacement(
            worldspace.FormKey.ToString(), BlockX: 3, BlockY: -2, SubX: 0, SubY: -1, IsInterior: false);

        var syntheticMod = SpatialContainerMint.BuildSyntheticWorldspaceMod(
            DestinationPlugin, worldspace, cellLocation, cell, sourceCell, GameRelease.Fallout4);

        var scratchDir = Directory.CreateTempSubdirectory("medit-mint-builder-test-").FullName;
        try
        {
            await RecordTextCodecGeneratorSeed.SerializeWholeMod(syntheticMod, scratchDir, InlineWorkDropoff.Instance, default);

            var worldspacesDir = Path.Combine(scratchDir, "Worldspaces");
            Assert.True(Directory.Exists(worldspacesDir));

            var blockDir = Directory.EnumerateDirectories(worldspacesDir, "*", SearchOption.AllDirectories)
                .SingleOrDefault(d => Path.GetFileName(d).EndsWith("3, -2", StringComparison.Ordinal));
            Assert.NotNull(blockDir);

            var subBlockDir = Directory.EnumerateDirectories(blockDir!)
                .SingleOrDefault(d => Path.GetFileName(d).EndsWith("0, -1", StringComparison.Ordinal));
            Assert.NotNull(subBlockDir);

            // The cell itself landed one level under the sub-block, its own document carrying the
            // source cell's grid — not the bare ancestor's, which has none of its own.
            var cellRecordFiles = Directory.EnumerateFiles(subBlockDir!, "RecordData.json", SearchOption.AllDirectories).ToList();
            var cellRecordFile = Assert.Single(cellRecordFiles);
            using var cellJson = JsonDocument.Parse(File.ReadAllText(cellRecordFile));
            Assert.Equal("200, -199", cellJson.RootElement.GetProperty("Grid").GetProperty("Point").GetString());

            // The WRLD ancestor's own header round-trips as Partial Form (bit 14, 0x4000).
            var worldspaceOwnDir = Directory.EnumerateDirectories(worldspacesDir).Single();
            var worldspaceHeaderFile = Path.Combine(worldspaceOwnDir, "RecordData.json");
            Assert.True(File.Exists(worldspaceHeaderFile));
            using var worldspaceJson = JsonDocument.Parse(File.ReadAllText(worldspaceHeaderFile));
            Assert.Equal(0x4000, worldspaceJson.RootElement.GetProperty("MajorRecordFlagsRaw").GetInt32());
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }
}
