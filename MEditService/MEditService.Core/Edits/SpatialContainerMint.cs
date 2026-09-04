using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Core.Edits;

/// <summary>Mints a WRLD/CELL directory without a path grammar (ADR-0041 declined one): a synthetic
/// one-subtree mod goes through the whole-mod serializer Track uses, and is FO4-typed because that
/// door is.</summary>
internal static class SpatialContainerMint
{
    /// <summary>Only wires the block/sub-block nesting between two already-constructed records, copying
    /// coordinates from <paramref name="cellLocation"/> rather than deriving them.</summary>
    internal static Fallout4Mod BuildSyntheticWorldspaceMod(
        PluginKey destinationPlugin, IMajorRecord worldspaceAncestor, CellLocationRow cellLocation, IMajorRecord cell,
        GameRelease release)
    {
        if (worldspaceAncestor is not Worldspace worldspace)
        {
            throw new ArgumentException(
                $"{worldspaceAncestor.GetType()} is not a Worldspace — the whole-mod door this mints through is FO4-only.",
                nameof(worldspaceAncestor));
        }
        if (cell is not Cell fo4Cell)
        {
            throw new ArgumentException(
                $"{cell.GetType()} is not a Cell — the whole-mod door this mints through is FO4-only.",
                nameof(cell));
        }

        var subBlock = new WorldspaceSubBlock
        {
            BlockNumberX = (short)(cellLocation.SubX ?? 0),
            BlockNumberY = (short)(cellLocation.SubY ?? 0),
        };
        subBlock.Items.Add(fo4Cell);

        var block = new WorldspaceBlock
        {
            BlockNumberX = (short)(cellLocation.BlockX ?? 0),
            BlockNumberY = (short)(cellLocation.BlockY ?? 0),
        };
        block.Items.Add(subBlock);

        worldspace.SubCells.Add(block);

        var mod = new Fallout4Mod(ModKey.FromFileName(destinationPlugin.Name), release.ToFallout4Release());
        mod.Worldspaces.Add(worldspace);
        return mod;
    }

    /// <summary>Read back off the tree the serializer wrote, never re-serialized, so the index row is
    /// byte-identical to the file it describes.</summary>
    internal readonly record struct SpatialMintResult(byte[] WorldspaceBody, byte[] CellBody);

    /// <summary>Folds the synthetic mod's <c>Worldspaces</c> subtree into the destination, never its
    /// default header. An existing worldspace override is merged one level down, minus the
    /// scratch worldspace's document, which must never overwrite the real one.</summary>
    internal static async Task<SpatialMintResult> MintAsync(
        Fallout4Mod syntheticMod, string destinationModFolder, string destinationPluginName,
        string? existingWorldspaceDirectory = null)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-spatial-mint-").FullName;
        try
        {
            await RecordTextCodecGeneratorSeed.SerializeWholeMod(
                syntheticMod, scratchDir, InlineWorkDropoff.Instance, CancellationToken.None);

            const string worldspacesFolder = "Worldspaces";
            const string recordDataFileName = "RecordData.json";
            var scratchWorldspaces = Path.Combine(scratchDir, worldspacesFolder);

            // Exactly one Worldspace and one Cell: the Cell's file is the other RecordData.json beneath
            // the WRLD's (placed refs serialize inline, per CellEmbedCustomization).
            var worldspaceOwnDir = Directory.EnumerateDirectories(scratchWorldspaces).Single();
            var worldspaceHeaderFile = Path.Combine(worldspaceOwnDir, recordDataFileName);
            var cellFile = Directory.EnumerateFiles(scratchWorldspaces, recordDataFileName, SearchOption.AllDirectories)
                .Single(f => !string.Equals(f, worldspaceHeaderFile, StringComparison.Ordinal));

            // Captured before the ordered child lists are spliced in: a worldspace's index document
            // must be what the codec round-trips, not that plus a tree-layout member.
            var result = new SpatialMintResult(
                await File.ReadAllBytesAsync(worldspaceHeaderFile), await File.ReadAllBytesAsync(cellFile));

            // Order is parent data (ADR-0042 decision 4); a subtree merged in without it is drift the
            // next compile refuses.
            SourceChildOrder.SpliceInto(scratchDir, syntheticMod);

            if (existingWorldspaceDirectory != null)
            {
                // Merged before the scratch header is removed: that file carries the SubCells order the
                // destination's list needs. The merge walks directories only, so the header never travels.
                MergeIntoExistingWorldspace(worldspaceOwnDir, existingWorldspaceDirectory);
                File.Delete(worldspaceHeaderFile);
            }
            else
            {
                var destinationWorldspaces = Path.Combine(
                    destinationModFolder, SourceRecordPath.RootFor(destinationPluginName), worldspacesFolder);
                SourceTreeMerge.MergeAdditively(scratchWorldspaces, destinationWorldspaces);

                // MergeAdditively never overwrites, so an existing Worldspaces/GroupRecordData.json would
                // keep a list that does not name the new worldspace.
                SourceChildOrder.MergeCarrierInto(scratchWorldspaces, destinationWorldspaces);
            }

            return result;
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }

    // Descends by matching name to the first level with no match, merging the ordered child list at
    // every level so the pass is idempotent against a destination that half-holds the subtree.
    // Terminates: MintExteriorCell refuses a FormKey the destination holds.
    private static void MergeIntoExistingWorldspace(string scratchWorldspaceDir, string existingWorldspaceDir)
    {
        var scratchLevel = scratchWorldspaceDir;
        var destinationLevel = existingWorldspaceDir;
        while (true)
        {
            var scratchChild = Directory.EnumerateDirectories(scratchLevel).Single();
            var identity = Path.GetFileName(scratchChild);
            var existing = Directory.EnumerateDirectories(destinationLevel)
                .SingleOrDefault(d => Path.GetFileName(d).Equals(identity, StringComparison.Ordinal));

            SourceChildOrder.MergeCarrierInto(scratchLevel, destinationLevel);

            if (existing == null)
            {
                SourceTreeMerge.MergeAdditively(scratchChild, Path.Combine(destinationLevel, identity));
                return;
            }

            scratchLevel = scratchChild;
            destinationLevel = existing;
        }
    }
}
