using System.Text.Json.Nodes;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>Mints a WRLD/CELL directory without a path grammar (ADR-0041 declined one): the codec
/// mints each level's document and the repository says where it goes.</summary>
internal static class SpatialContainerMint
{
    /// <summary>Places <paramref name="cell"/> and its bare worldspace ancestor at
    /// <paramref name="location"/>'s block levels, folding a scratch subtree in so an existing
    /// worldspace is merged into rather than overwritten.</summary>
    internal static void Mint(
        RecordTextCodec codec,
        RecordCopy.Destination destination,
        GameRelease release,
        CellPlacement location,
        IMajorRecord worldspaceAncestor,
        string worldspaceRecordType,
        IMajorRecord cell,
        string cellRecordType,
        IMajorRecord sourceCell,
        string? existingWorldspaceDirectory)
    {
        var levels = RecordTypeDispatch.For(release).ExteriorCellBlockLevels;
        if (levels.Count != BlockLevels)
        {
            throw new NotSupportedException(
                $"{release} nests an exterior cell under {levels.Count} block levels, and the source " +
                $"tree's layout has exactly {BlockLevels}.");
        }

        var subtree = SourceRepository.ExteriorCellSubtreeFor(
            destination.Plugin.Name, worldspaceRecordType, worldspaceAncestor.FormKey.ToString(),
            worldspaceAncestor.EditorID, cell.FormKey.ToString(), cell.EditorID, location, release);

        var scratch = Directory.CreateTempSubdirectory("medit-spatial-mint-").FullName;
        try
        {
            Place(scratch, subtree.WorldspaceDocument, codec.SerializeToText(worldspaceAncestor, release));
            Place(scratch, subtree.BlockGroupDocument,
                RecordTextCodec.BlankDocument(levels[0], release, BlockNumbers(location.BlockX, location.BlockY)));
            Place(scratch, subtree.SubBlockGroupDocument,
                RecordTextCodec.BlankDocument(levels[1], release, BlockNumbers(location.SubX, location.SubY)));
            Place(scratch, subtree.CellDocument, CellDocumentWithGrid(codec, release, cell, cellRecordType, sourceCell));

            if (existingWorldspaceDirectory != null)
            {
                // The merge walks directories only, so the scratch worldspace's own document never
                // overwrites the real one.
                MergeIntoExistingWorldspace(
                    Path.Combine(scratch, subtree.WorldspaceDirectory), existingWorldspaceDirectory);
            }
            else
            {
                SourceTreeMerge.MergeAdditively(
                    Path.Combine(scratch, subtree.GroupDirectory),
                    Path.Combine(destination.ModFolder, subtree.GroupDirectory));
            }
        }
        finally
        {
            Directory.Delete(scratch, recursive: true);
        }
    }

    private const int BlockLevels = 2;

    private static void Place(string modFolder, SourcePlacement placement, string document) =>
        SourceRepository.WriteAt(modFolder, placement, path =>
        {
            SourceRepository.WriteTextAtomic(path, document);
            return document;
        });

    private static JsonObject BlockNumbers(int? x, int? y) => new()
    {
        [RecordTypeDispatch.BlockNumberXMember] = x ?? 0,
        [RecordTypeDispatch.BlockNumberYMember] = y ?? 0,
    };

    // A bare ancestor carries no grid of its own; the source cell's document does, so the grid rides
    // along as a member and the codec respells the result.
    private static string CellDocumentWithGrid(
        RecordTextCodec codec, GameRelease release, IMajorRecord cell, string cellRecordType, IMajorRecord sourceCell)
    {
        var document = codec.SerializeToText(cell, release);
        var grid = JsonNode.Parse(codec.SerializeToText(sourceCell, release))!
            .AsObject()[RecordTypeDispatch.CellGridMember];
        if (grid == null) return document;

        var withGrid = JsonNode.Parse(document)!.AsObject();
        withGrid[RecordTypeDispatch.CellGridMember] = grid.DeepClone();
        return codec.RoundTrip(withGrid.ToJsonString(), release, cellRecordType);
    }

    // Descends by matching name to the first level with no match, so the pass is idempotent against a
    // destination that half-holds the subtree. Terminates: MintExteriorCell refuses a FormKey the
    // destination holds.
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
