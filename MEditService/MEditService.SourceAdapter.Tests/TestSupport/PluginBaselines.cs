using MEditService.Codec.Serialization;

namespace MEditService.SourceAdapter.Tests.TestSupport;

/// <summary>A fixture's placed files as the plugins Track commits: one per plugin whose source
/// root holds them, handed in under that root as the whole-mod door's tree, carrying no fact
/// beyond the plugin's name.</summary>
internal static class PluginBaselines
{
    internal static void Track(string modFolder, IEnumerable<TreeFile> files) =>
        SourceRepository.Track(modFolder, Of(files));

    /// <summary>A repository holding one plugin with no record, for a test that brings its own.</summary>
    internal static void TrackWithNoRecords(string modFolder) =>
        Track(modFolder, [new TreeFile("plugin-source/Seed.esp/seed.txt", [])]);

    internal static IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> Of(IEnumerable<TreeFile> files) =>
    [
        .. files.Select(file => (Plugin: PluginRootOf(file.RelativePath), File: file))
            .GroupBy(placed => placed.Plugin, StringComparer.Ordinal)
            .Select(plugin => ((IReadOnlyList<TreeFile>)[.. plugin.Select(placed => UnderRoot(placed.File))],
                new DecompiledPlugin(plugin.Key, null))),
    ];

    private static TreeFile UnderRoot(TreeFile placed) =>
        placed with { RelativePath = Path.Combine(Segments(placed.RelativePath)[2..]) };

    private static string PluginRootOf(string relativePath) =>
        Segments(relativePath) is ["plugin-source", var plugin, _, ..]
            ? plugin
            : throw new ArgumentException($"'{relativePath}' is not under a plugin's source root.", nameof(relativePath));

    private static string[] Segments(string relativePath) => relativePath.Split('/', '\\');
}
