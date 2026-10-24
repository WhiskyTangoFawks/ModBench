using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.TestSupport;

/// <summary>A fixture's placed files as the plugins init commits: one per plugin whose source
/// root holds them, handed in under that root as the whole-mod door's tree, in a mod with no
/// assets.</summary>
internal static class PluginBaselines
{
    internal static void Init(string sourceFolder, IEnumerable<TreeFile> files)
    {
        if (TestAdapters.Source().Init(sourceFolder, Of(files)) is { } failure)
            throw new InvalidOperationException($"Expected the fixture to init, and it was refused: {failure.Reason}");
    }

    /// <summary>A repository holding one plugin with no record, for a test that brings its own.</summary>
    internal static void InitWithNoRecords(string sourceFolder) =>
        Init(sourceFolder, [new TreeFile("plugin-source/Seed.esp/seed.txt", [])]);

    internal static IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> Of(IEnumerable<TreeFile> files) =>
    [
        .. files.Select(file => (Plugin: PluginRootOf(file.RelativePath), File: file))
            .GroupBy(placed => placed.Plugin, StringComparer.Ordinal)
            .Select(plugin => ((IReadOnlyList<TreeFile>)[.. plugin.Select(placed => UnderRoot(placed.File))],
                Decompiled(plugin.Key))),
    ];

    /// <summary>The test mod's <paramref name="plugin"/>, decompiled from the binary hashing to
    /// <paramref name="binarySha256"/> when one is given.</summary>
    internal static DecompiledPlugin Decompiled(string plugin, string? binarySha256 = null) =>
        new(new PluginAddress(plugin, TestMod.Name), binarySha256);

    /// <summary>The test mod's <paramref name="plugin"/>, whose whole-mod door's tree is one empty NPC document.</summary>
    internal static (IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin) OneRecordOf(string plugin, string? binarySha256 = null) =>
        ([new TreeFile($"npc_/{plugin}/000001.json", "{}"u8.ToArray())], Decompiled(plugin, binarySha256));

    private static TreeFile UnderRoot(TreeFile placed) =>
        placed with { RelativePath = Path.Combine(Segments(placed.RelativePath)[2..]) };

    private static string PluginRootOf(string relativePath) =>
        Segments(relativePath) is ["plugin-source", var plugin, _, ..]
            ? plugin
            : throw new ArgumentException($"'{relativePath}' is not under a plugin's source root.", nameof(relativePath));

    private static string[] Segments(string relativePath) => relativePath.Split('/', '\\');
}
