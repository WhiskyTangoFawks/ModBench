using System.Collections.Concurrent;
using System.Security.Cryptography;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Init is the slow step of a compiled plugin fixture and leaves a mod folder naming no
/// absolute path, so each distinct mod folder is initialised once per run and copied into every test's
/// own.</summary>
internal static class CompiledPluginTemplates
{
    private static readonly ConcurrentDictionary<string, Lazy<ScratchDirectory>> Folders = new(StringComparer.Ordinal);

    static CompiledPluginTemplates() =>
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            foreach (var folder in Folders.Values.Where(folder => folder.IsValueCreated))
                folder.Value.Dispose();
        };

    /// <summary>Fills <paramref name="modFolder"/> as <paramref name="make"/> fills an empty mod
    /// folder. <paramref name="key"/> names everything <paramref name="make"/> writes, which runs
    /// once per key.</summary>
    internal static void CopyInto(string modFolder, string key, Action<string> make)
    {
        var template = Folders.GetOrAdd(key, _ => new Lazy<ScratchDirectory>(() =>
        {
            var folder = new ScratchDirectory("medit-compiled-plugin-template-");
            make(folder.Path);
            return folder;
        })).Value;
        CopyDirectory(template.Path, modFolder);
    }

    /// <summary><paramref name="mod"/>, which has no masters, written into
    /// <paramref name="modFolder"/> and made a source mod there. Keyed on its bytes, so fixtures share a
    /// template only when their plugins are one.</summary>
    internal static void WriteCompiledPlugin(string modFolder, IModGetter mod)
    {
        using var binary = new MemoryStream();
        mod.WriteToBinary(binary);
        var bytes = binary.ToArray();
        var pluginName = mod.ModKey.FileName.String;
        CopyInto(modFolder, $"{pluginName} {Convert.ToHexString(SHA256.HashData(bytes))}", template =>
        {
            File.WriteAllBytes(Path.Combine(template, pluginName), bytes);
            InitAlone(template, pluginName, mod.GameRelease);
        });
    }

    /// <summary>Inits the mod of the one plugin <paramref name="modFolder"/> holds, in a load order of that
    /// plugin alone.</summary>
    internal static void InitAlone(string modFolder, string pluginName, GameRelease release = GameRelease.Fallout4)
    {
        const string origin = "TemplateMod";
        using var gameDirectory = new ScratchDirectory("medit-compiled-plugin-template-game-");
        var loadOrder = SnapshotPlugins.Snapshot(gameDirectory, instanceRoot: null, release,
            [new LoadOrderEntry(pluginName, Path.Combine(modFolder, pluginName), origin, Line: 0, Enabled: true, Winning: true)]);
        var result = DecompileAndCommitEveryPluginOf.ModAsync(loadOrder, origin)
            .GetAwaiter().GetResult();
        if (!result.Only().Applied)
            throw new InvalidOperationException($"Expected {pluginName} to init: {string.Join("; ", result.RefusalMessages())}");
    }

    internal static void CopyDirectory(string sourceFolder, string destinationFolder)
    {
        foreach (var directory in Directory.EnumerateDirectories(sourceFolder, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(destinationFolder, Path.GetRelativePath(sourceFolder, directory)));

        foreach (var file in Directory.EnumerateFiles(sourceFolder, "*", SearchOption.AllDirectories))
            File.Copy(file, Path.Combine(destinationFolder, Path.GetRelativePath(sourceFolder, file)));
    }
}
