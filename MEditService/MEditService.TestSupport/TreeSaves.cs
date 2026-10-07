using System.Text;
using MEditService.Codec.Serialization;
using MEditService.PluginAdapter;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.TestSupport;

/// <summary>A plugin saved as compile saves it: its source tree compiled to a mod, then prepared
/// through <see cref="CompiledTree.PrepareSaveAsync"/>.</summary>
public static class TreeSaves
{
    /// <summary>The masters follow <paramref name="loadOrder"/>, or the plugin's own where it is null.
    /// Each edit replaces text in the tree before it compiles.</summary>
    public static async Task<PreparedPluginSave> PrepareAsync(
        string pluginPath,
        IReadOnlyList<string>? loadOrder = null,
        params (string From, string To)[] textEdits)
    {
        var adapter = TestAdapters.Mutagen();
        var name = Path.GetFileName(pluginPath);
        var modPath = new ModPath(ModKey.FromFileName(name), pluginPath);
        var (files, missingStrings) = await adapter.ReadSourceAsync(
            modPath, name, GameRelease.Fallout4, new PluginStrings(null, Path.GetDirectoryName(pluginPath) ?? throw new ArgumentException("No folder.", nameof(pluginPath))));
        if (missingStrings is not null) throw new InvalidOperationException($"{name} declares {missingStrings}, which the disk lacks.");

        var edited = files.Select(file => new TreeFile(
            file.RelativePath,
            Encoding.UTF8.GetBytes(textEdits.Aggregate(
                Encoding.UTF8.GetString(file.Content),
                (text, edit) => text.Replace(edit.From, edit.To, StringComparison.Ordinal))))).ToList();

        var (tree, diagnosis, error) = await adapter.ReadTreeAsync(
            edited, new RecordTextCodec(NullLogger<RecordTextCodec>.Instance), GameRelease.Fallout4);
        if (tree is null) throw new InvalidOperationException($"{name}'s source tree will not compile: {diagnosis}", error);

        return await tree.PrepareSaveAsync(
            pluginPath, loadOrder ?? adapter.ReadContent(modPath, GameRelease.Fallout4).Content.Masters);
    }
}
