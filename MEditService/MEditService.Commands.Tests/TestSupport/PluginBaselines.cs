using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A fixture's pristine files as the baselines Track commits: one per plugin whose source
/// root holds them, carrying no fact beyond the plugin's name.</summary>
internal static class PluginBaselines
{
    internal static void Track(string modFolder, SourcePreset preset, IEnumerable<TreeFile> files) =>
        SourceRepository.Track(modFolder, preset, Of(files));

    internal static IReadOnlyList<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)> Of(IEnumerable<TreeFile> files) =>
    [
        .. files.GroupBy(file => PluginRootOf(file.RelativePath), StringComparer.Ordinal)
            .Select(plugin => ((IReadOnlyList<TreeFile>)[.. plugin], new BaselineTrailers(plugin.Key, null, null, null))),
    ];

    private static string PluginRootOf(string relativePath) =>
        relativePath.Split('/', '\\') is ["source", var plugin, _, ..]
            ? plugin
            : throw new ArgumentException($"'{relativePath}' is not under a plugin's source root.", nameof(relativePath));
}
