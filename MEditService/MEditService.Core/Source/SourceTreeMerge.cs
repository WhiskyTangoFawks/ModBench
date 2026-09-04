namespace MEditService.Core.Source;

/// <summary>Folds every file under a source directory into a destination tree at its own relative
/// path. Additive, never a wholesale replace: the destination already holds other records this
/// operation must not touch.</summary>
internal static class SourceTreeMerge
{
    /// <summary>Byte-identical collisions are a no-op (a retried mint landing the same bytes is not a
    /// conflict); a collision with different bytes throws rather than silently overwriting.</summary>
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

            // Per file and unminted on failure: a copy that throws must not leave the directories it just
            // needed standing empty (#675). Earlier files keep theirs — this merge is additive.
            SourceUnitResolver.InMintedDirectory(
                Path.GetDirectoryName(destinationFile)!, () => File.Copy(sourceFile, destinationFile));
        }
    }

    private static bool FilesAreByteIdentical(string left, string right) =>
        File.ReadAllBytes(left).AsSpan().SequenceEqual(File.ReadAllBytes(right));
}
