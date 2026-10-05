using MEditService.Codec.Serialization;

namespace MEditService.SourceAdapter.Tests.TestSupport;

/// <summary>A fixture's pristine files as the plugins Track commits: one per plugin whose source
/// root holds them, carrying no fact beyond the plugin's name.</summary>
internal static class PluginBaselines
{
    internal static void Track(string modFolder, IEnumerable<TreeFile> files) =>
        SourceRepository.Track(modFolder, Of(files));

    /// <summary>A repository holding one plugin with no record, for a test that brings its own.</summary>
    internal static void TrackWithNoRecords(string modFolder) =>
        Track(modFolder, [new TreeFile("plugin-source/Seed.esp/seed.txt", [])]);

    internal static IReadOnlyList<(IReadOnlyList<TreeFile> Files, DecompiledPlugin Plugin)> Of(IEnumerable<TreeFile> files) =>
    [
        .. files.GroupBy(file => PluginRootOf(file.RelativePath), StringComparer.Ordinal)
            .Select(plugin => ((IReadOnlyList<TreeFile>)[.. plugin], new DecompiledPlugin(plugin.Key, null))),
    ];

    private static string PluginRootOf(string relativePath) =>
        relativePath.Split('/', '\\') is ["plugin-source", var plugin, _, ..]
            ? plugin
            : throw new ArgumentException($"'{relativePath}' is not under a plugin's source root.", nameof(relativePath));
}
