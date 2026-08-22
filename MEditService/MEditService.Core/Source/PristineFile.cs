namespace MEditService.Core.Source;

/// <summary>One file <see cref="SourceRepository.Track"/> writes into the mod folder and commits
/// as part of the pristine baseline — a serialized source record, or the generated
/// <c>.gitignore</c>. <paramref name="RelativePath"/> is relative to the mod folder (the repo's
/// own working tree) and forward-slash-shaped, matching <c>SourceRecordPath.For</c>'s own
/// <c>Path.Combine</c> output on this project's Linux-only runtime.</summary>
public sealed record PristineFile(string RelativePath, byte[] Content);

/// <summary>
/// The one way a list of <see cref="PristineFile"/>s becomes real files under some base directory —
/// <c>Path.Combine(baseDirectory, file.RelativePath)</c>, create the parent, write the bytes.
/// Extracted (#471 review) after a third call site (<c>TrackService.VerifyRoundTrip</c>'s scratch
/// write, materializing a plugin's just-serialized tree to recompile it) made three independent
/// copies of the same three lines — <see cref="SourceRepository.Track"/>'s pristine-baseline write
/// and <see cref="SourceRepository.CommitPristineToMain"/>'s scratch write were already two. Both a
/// sync and an async form, rather than forcing one shape on every caller: the two
/// <see cref="SourceRepository"/> call sites are synchronous git-mechanics methods with no
/// <c>async</c> context of their own to extend, while the round-trip gate is already deep inside an
/// <c>async</c> method and awaits its own writes elsewhere in the same loop.
/// </summary>
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

/// <summary>Provenance <see cref="SourceRepository.Track"/> writes as commit trailers on the
/// pristine baseline (ADR-0041 amendment) — inputs, never invented here: the backend computes the
/// hash, version strings arrive as opaque data. All optional (authored/manually-installed mods may
/// have none of them). <paramref name="BinarySha256ByPlugin"/> is keyed by plugin file name because
/// a mod folder can hold more than one plugin, each needing its own <c>Binary-SHA256</c> trailer
/// line and its own parked <c>refs/medit/last-compile/&lt;plugin&gt;</c> ref.</summary>
public sealed record TrackProvenance(
    string? UpstreamVersion,
    string? MetaSha256,
    IReadOnlyDictionary<string, string> BinarySha256ByPlugin);

/// <summary>The two <c>.gitignore</c> presets ADR-0041 names — Edits is the default for downloaded
/// mods (source only); Everything additionally tracks assets. Plugin binaries are ignored in both;
/// <c>meta.ini</c> is ignored in both (never tracked content, ADR-0041 amendment).</summary>
public enum SourcePreset
{
    Edits,
    Everything,
}
