using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;
using Noggog.WorkEngine;

namespace MEditService.Tests.Edits;

/// <summary>
/// <see cref="SpatialContainerMint.BuildSyntheticWorldspaceMod"/> in isolation — no
/// <see cref="MEditService.Core.Edits.RecordEditService"/> involved, just the builder plus the real
/// whole-mod serializer it hands its output to.
/// </summary>
public sealed class SpatialContainerMintBuilderTests
{
    private static readonly PluginKey DestinationPlugin = new("Destination.esp", "DestinationMod");

    [Fact]
    public async Task BuildSyntheticWorldspaceMod_ThenSerializeWholeMod_WritesBlockAndSubBlockFoldersNamedFromCellLocation()
    {
        var worldspace = (IMajorRecord)MajorRecordInstantiator.Activator(
            FormKey.Factory("000801:Source.esm"), GameRelease.Fallout4, typeof(Worldspace));
        PartialFormFlag.Set(worldspace, true);

        var cell = (IMajorRecord)MajorRecordInstantiator.Activator(
            FormKey.Factory("000802:Source.esm"), GameRelease.Fallout4, typeof(Cell));
        PartialFormFlag.Set(cell, true);

        // Deliberately not derivable from a naive floor(grid/N)-style formula for this grid point —
        // a rival that recomputed block/sub-block instead of copying CellLocationRow's own numbers
        // through would not reproduce these exact values.
        var cellLocation = new CellLocationRow(
            cell.FormKey.ToString(), worldspace.FormKey.ToString(),
            BlockX: 3, BlockY: -2, SubX: 0, SubY: -1, GridX: 200, GridY: -199, IsInterior: false);

        var syntheticMod = SpatialContainerMint.BuildSyntheticWorldspaceMod(DestinationPlugin, worldspace, cellLocation, cell, GameRelease.Fallout4);

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

            // The cell itself landed one level under the sub-block.
            var cellRecordFiles = Directory.EnumerateFiles(subBlockDir!, "RecordData.json", SearchOption.AllDirectories).ToList();
            Assert.Single(cellRecordFiles);

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
