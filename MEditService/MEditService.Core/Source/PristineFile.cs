namespace MEditService.Core.Source;

/// <summary>One file Track writes into the mod folder and commits as part of the pristine baseline.
/// <paramref name="RelativePath"/> is relative to the mod folder and forward-slash-shaped.</summary>
public sealed record PristineFile(string RelativePath, byte[] Content);

/// <summary>The one way a list of <see cref="PristineFile"/>s becomes real files under a base directory,
/// shared so the call sites cannot drift. Sync and async forms: the git-mechanics callers have no
/// async context.</summary>
internal static class PristineFileWriter
{
    internal static void WriteAll(IEnumerable<PristineFile> files, string baseDirectory)
    {
        foreach (var file in files)
        {
            var fullPath = Path.Combine(baseDirectory, file.RelativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
            File.WriteAllBytes(fullPath, file.Content);
        }
    }

    internal static async Task WriteAllAsync(IEnumerable<PristineFile> files, string baseDirectory, CancellationToken cancel = default)
    {
        foreach (var file in files)
        {
            var fullPath = Path.Combine(baseDirectory, file.RelativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
            await File.WriteAllBytesAsync(fullPath, file.Content, cancel);
        }
    }
}

/// <summary>Provenance written as commit trailers on the pristine baseline (ADR-0041 amendment) —
/// inputs, never invented here. Hashes are keyed by plugin file name because a mod folder can hold
/// more than one plugin, each with its own trailer.</summary>
public sealed record TrackProvenance(
    string? UpstreamVersion,
    string? MetaSha256,
    IReadOnlyDictionary<string, string> BinarySha256ByPlugin);

/// <summary>The two <c>.gitignore</c> presets ADR-0041 names: Edits tracks source only; Everything
/// additionally tracks assets. Plugin binaries and <c>meta.ini</c> are ignored in both.</summary>
public enum SourcePreset
{
    Edits,
    Everything,
}
