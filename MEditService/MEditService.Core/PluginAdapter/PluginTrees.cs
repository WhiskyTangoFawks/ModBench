using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Core.PluginAdapter;

/// <summary>How a source tree becomes a live mod. Only a negative test substitutes one; the real
/// deserialize is the codec's whole-mod door.</summary>
internal delegate Task<IMod> TreeDeserializer(string treeRoot, CancellationToken cancel);

/// <summary>A plugin's binary and its source tree, composed: the codec's whole-mod door on one side
/// and this adapter's open and write on the other, so no caller holds the live mod between
/// them.</summary>
internal static class PluginTrees
{
    /// <summary>A plugin's own binary read as the documents its tree would hold.
    /// <see cref="PluginTree.MissingStringsFile"/> names the localization file it declares and the
    /// disk does not have, in which case there are no files.</summary>
    internal readonly record struct PluginTree(IReadOnlyList<PristineFile> Files, string? MissingStringsFile);

    internal static async Task<PluginTree> ReadAsync(
        string pluginName, string pluginPath, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default)
    {
        var mod = MutagenPluginAdapter.Instance.OpenForWrite(
            new ModPath(ModKey.FromFileName(pluginName), pluginPath), gameRelease, strings);

        // Refuse by name before any serialize: TranslatedString.TryLookup returns false for a missing
        // file with no exception.
        return LocalizedStrings.FindMissingStringsFile(mod, pluginName, strings, gameRelease) is { } missing
            ? new PluginTree([], missing)
            : new PluginTree(await SerializeToPristineFiles(mod, pluginName, cancel), null);
    }

    /// <summary>One plugin's complete source tree, ready to commit — the one implementation of the
    /// door's write. A second serializer that dropped the root RecordData.json would delete the header
    /// from the baseline.</summary>
    internal static async Task<IReadOnlyList<PristineFile>> SerializeToPristineFiles(
        IModGetter mod, string pluginName, CancellationToken cancel = default)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-serialize-").FullName;
        try
        {
            // Always the inline dropoff, explicitly: MajorRecordListParallelHelper has a real upstream race
            // under a genuinely parallel dropoff (nested-list containers writing into each other's folders).
            await RecordTextCodecGeneratorSeed.SerializeWholeMod(
                // FO4-typed: the generated whole-mod mixin is itself seeded from an FO4 mod type — the existing
                // generalization boundary.
                (IFallout4ModGetter)mod,
                scratchDir,
                InlineWorkDropoff.Instance,
                cancel);

            // Newtonsoft's JsonTextWriter has no reachable NewLine to pin, so line endings are canonicalized
            // after the write, as the per-record codec does.
            var pristineFiles = new List<PristineFile>();
            foreach (var file in Directory.EnumerateFiles(scratchDir, "*", SearchOption.AllDirectories))
            {
                cancel.ThrowIfCancellationRequested();
                var relativePath = Path.Combine(
                    SourceRepository.RootFor(pluginName), Path.GetRelativePath(scratchDir, file));
                pristineFiles.Add(new PristineFile(relativePath, StripCarriageReturns(await File.ReadAllBytesAsync(file, cancel))));
            }
            return pristineFiles;
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }

    /// <summary>The tree at <paramref name="treeRoot"/> compiled to bytes at
    /// <paramref name="destinationPath"/>, with neither backup nor rename: a scratch verification must
    /// not drop a .bak beside the real plugin.</summary>
    internal static async Task WriteFromTreeAsync(
        string treeRoot, string destinationPath, TreeDeserializer? deserialize = null,
        CancellationToken cancel = default)
    {
        var recompiled = await (deserialize ?? DeserializeTree)(treeRoot, cancel);
        await MutagenPluginAdapter.Instance.WriteAsync(recompiled, destinationPath);
    }

    private static async Task<IMod> DeserializeTree(string treeRoot, CancellationToken cancel) =>
        await RecordTextCodecGeneratorSeed.DeserializeWholeMod(treeRoot, InlineWorkDropoff.Instance, cancel);

    /// <summary>The codec's verdict on the plugin written at <paramref name="recompiledPath"/> against
    /// the one at <paramref name="originalPath"/>; null when they are model-identical. Both are
    /// reparsed, since only written bytes show what the writer does.</summary>
    internal static ModelIdentity.Divergence? DivergenceBetween(
        string pluginName, string originalPath, string recompiledPath, GameRelease gameRelease, PluginStrings strings)
    {
        var modKey = ModKey.FromFileName(pluginName);
        var original = MutagenPluginAdapter.Instance.OpenForWrite(
            new ModPath(modKey, originalPath), gameRelease, strings);
        var recompiled = MutagenPluginAdapter.Instance.OpenForWrite(
            new ModPath(modKey, recompiledPath), gameRelease);

        return ModelIdentity.FindFirstDivergence(original, recompiled);
    }

    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];
}
