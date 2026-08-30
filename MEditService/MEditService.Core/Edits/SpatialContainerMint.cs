using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Core.Edits;

/// <summary>
/// #549 Arc B (AC1): mints a brand-new WRLD/CELL directory into a destination plugin's working tree,
/// at the exact spatial position (worldspace block/sub-block) the source plugin's own already-parsed
/// object graph carries — without ever computing that position itself. ADR-0041 twice declined a
/// path-computation grammar for containers (#453/#454: "container source units are found by scanning
/// the tree, never by computing a path"); this does not reopen that, because it never computes a
/// path. It builds a synthetic, minimal <see cref="Fallout4Mod"/> holding only the new subtree (one
/// <see cref="Worldspace"/> → one <see cref="WorldspaceBlock"/>/<see cref="WorldspaceSubBlock"/>, whose
/// own <c>BlockNumberX/Y</c> are copied verbatim from a <see cref="CellLocationRow"/> the caller
/// already read off the source → one <see cref="Cell"/>) and runs it through the very same whole-mod
/// serializer Track uses (<see cref="RecordTextCodecGeneratorSeed.SerializeWholeMod"/>) — so the
/// directory names it writes are exactly the ones the source's own tree already uses for this cell,
/// because the serializer is the one and only thing that ever decides them.
///
/// <para>FO4-typed throughout, deliberately: the whole-mod door itself already only exists for FO4
/// (<see cref="RecordTextCodecGeneratorSeed"/>'s own doc comment — the generated mixin is seeded from
/// an FO4 mod type), so this inherits that door's existing generalization boundary rather than drawing
/// a new one.</para>
///
/// <para>A designated door for <see cref="RecordTextCodecGeneratorSeed.SerializeWholeMod"/>, alongside
/// <see cref="Source.TrackService"/> — listed in <c>RecordTextCodecGeneratorSeedTests</c>' own
/// whitelist the same way Track was when it shipped (#451 AC2 re-scope: "a whitelist of the doors that
/// pay that cost deliberately, once, in their own designated place").</para>
/// </summary>
internal static class SpatialContainerMint
{
    /// <summary>
    /// Builds the synthetic mod. <paramref name="worldspaceAncestor"/> and <paramref name="cell"/> are
    /// already-constructed records (bare/Partial-Form auto-created ancestors, or the real thing) —
    /// this method only wires the <see cref="WorldspaceBlock"/>/<see cref="WorldspaceSubBlock"/>
    /// structural nesting between them, copying its two coordinate pairs from
    /// <paramref name="cellLocation"/> rather than deriving them from anything.
    /// </summary>
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

    /// <summary>The two file bodies a mint actually changes the index for — read back off the
    /// scratch tree the serializer itself wrote, never re-serialized independently, so the index's
    /// row is guaranteed byte-identical to the working-tree file it now describes (the same rule
    /// every other write path here already follows — "the source text is the source, not the
    /// index").</summary>
    internal readonly record struct SpatialMintResult(byte[] WorldspaceBody, byte[] CellBody);

    /// <summary>Serializes <paramref name="syntheticMod"/> through the whole-mod door into a scratch
    /// directory, then folds only its <c>Worldspaces</c> subtree into the destination's existing
    /// source tree (<see cref="SourceTreeMerge.MergeAdditively"/>) — never the synthetic mod's own
    /// root-level header file, which is a bare default the destination's real, already-tracked header
    /// must not be merged against.</summary>
    internal static async Task<SpatialMintResult> MintAsync(
        Fallout4Mod syntheticMod, string destinationModFolder, string destinationPluginName)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-spatial-mint-").FullName;
        try
        {
            await RecordTextCodecGeneratorSeed.SerializeWholeMod(
                syntheticMod, scratchDir, InlineWorkDropoff.Instance, CancellationToken.None);

            const string worldspacesFolder = "Worldspaces";
            const string recordDataFileName = "RecordData.json";
            var scratchWorldspaces = Path.Combine(scratchDir, worldspacesFolder);

            // Exactly one Worldspace, one Cell, in this synthetic mod: the WRLD's own header file
            // sits directly inside the group's one subdirectory; the Cell's own file is the other
            // RecordData.json anywhere beneath it (Persistent/Temporary refs serialize inline into
            // it, per SpriggitCellEmbedCustomization — never as files of their own).
            var worldspaceOwnDir = Directory.EnumerateDirectories(scratchWorldspaces).Single();
            var worldspaceHeaderFile = Path.Combine(worldspaceOwnDir, recordDataFileName);
            var cellFile = Directory.EnumerateFiles(scratchWorldspaces, recordDataFileName, SearchOption.AllDirectories)
                .Single(f => !string.Equals(f, worldspaceHeaderFile, StringComparison.Ordinal));

            var result = new SpatialMintResult(
                await File.ReadAllBytesAsync(worldspaceHeaderFile), await File.ReadAllBytesAsync(cellFile));

            var destinationWorldspaces = Path.Combine(
                destinationModFolder, SourceRecordPath.RootFor(destinationPluginName), worldspacesFolder);
            SourceTreeMerge.MergeAdditively(scratchWorldspaces, destinationWorldspaces);

            return result;
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }
}
