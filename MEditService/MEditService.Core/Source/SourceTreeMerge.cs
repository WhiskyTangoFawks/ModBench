namespace MEditService.Core.Source;

/// <summary>
/// Folds every file under <c>sourceDir</c> into <c>destinationDir</c> at its own relative path
/// — the counterpart <see cref="Edits.SpatialContainerMint"/> needs to land a synthetic whole-mod
/// door's scratch output into a destination plugin's already-existing working tree without disturbing
/// anything already there. Deliberately additive rather than a wholesale directory replace: the
/// destination tree can (and, for every real caller here, does) already hold other records this
/// operation must not touch — a naive "clear the target then copy" would delete every one of them.
/// </summary>
internal static class SourceTreeMerge
{
    /// <summary>
    /// Copies every file under <paramref name="sourceDir"/> to its same-relative-path location under
    /// <paramref name="destinationDir"/>, creating whatever intermediate directories are missing.
    /// Byte-identical collisions are a no-op (the same convergence rule <c>IRecordIndex.ApplyWorkingTreeChanges</c>'s
    /// own doc comment states — a retried mint landing the exact bytes it already landed is not a
    /// conflict); a collision with <b>different</b> bytes throws rather than silently overwriting
    /// (never assume exclusive ownership of a file on disk — root CLAUDE.md).
    /// </summary>
    internal static void MergeAdditively(string sourceDir, string destinationDir)
    {
        foreach (var sourceFile in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
        {
            var relativePath = Path.GetRelativePath(sourceDir, sourceFile);
            var destinationFile = Path.Combine(destinationDir, relativePath);

            if (File.Exists(destinationFile))
            {
                if (FilesAreByteIdentical(sourceFile, destinationFile)) continue;
                throw new InvalidOperationException(
                    $"{relativePath} already exists in the destination tree with different content — " +
                    "refusing to overwrite it.");
            }

            // Per file, and unminted on failure: a copy that throws must not leave the block/sub-block/
            // cell directories it just needed standing empty in the destination tree
            // (#675 — SourceUnitResolver.InMintedDirectory's own doc comment for why an empty one is
            // not inert). Not a transaction: earlier files that did land keep their directories, which
            // is correct — those directories hold content, and this merge is additive by design.
            SourceUnitResolver.InMintedDirectory(
                Path.GetDirectoryName(destinationFile)!, () => File.Copy(sourceFile, destinationFile));
        }
    }

    private static bool FilesAreByteIdentical(string left, string right) =>
        File.ReadAllBytes(left).AsSpan().SequenceEqual(File.ReadAllBytes(right));
}
