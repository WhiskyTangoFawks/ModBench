using MEditService.Codec.Serialization;
using MEditService.LoadOrder;

namespace MEditService.SourceRepo;

/// <summary>The one way a list of <see cref="TreeFile"/>s becomes real files under a base
/// directory, shared so the call sites cannot drift.</summary>
internal static class PristineFileWriter
{
    internal static void WriteAll(IEnumerable<TreeFile> files, string baseDirectory)
    {
        foreach (var file in files)
        {
            var fullPath = Path.Combine(baseDirectory, file.RelativePath);
            Directory.CreateDirectory(PathShape.DirectoryOf(fullPath));
            File.WriteAllBytes(fullPath, file.Content);
        }
    }
}

/// <summary>Provenance written as commit trailers on the pristine baseline (ADR-0003) —
/// inputs, never invented here. Hashes are keyed by plugin file name because a mod folder can hold
/// more than one plugin, each with its own trailer.</summary>
public sealed record TrackProvenance(
    string? UpstreamVersion,
    string? MetaSha256,
    IReadOnlyDictionary<string, string> BinarySha256ByPlugin);

/// <summary>The two <c>.gitignore</c> presets ADR-0007 names: Edits tracks source only; Everything
/// additionally tracks assets. Plugin binaries and <c>meta.ini</c> are ignored in both.</summary>
public enum SourcePreset
{
    Edits,
    Everything,
}
