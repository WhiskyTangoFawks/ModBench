using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Analysis;
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
        var mod = OpenFor(pluginName, pluginPath, gameRelease, strings);

        // Refuse by name before any serialize: TranslatedString.TryLookup returns false for a missing
        // file with no exception.
        return LocalizedStrings.FindMissingStringsFile(mod, pluginName, strings, gameRelease) is { } missing
            ? new PluginTree([], missing)
            : new PluginTree(await SerializeToPristineFiles(mod, pluginName, cancel), null);
    }

    /// <summary>A plugin's binary re-serialized as its whole source tree, with no localization
    /// check: what a re-baseline of an already tracked plugin commits.</summary>
    internal static Task<IReadOnlyList<PristineFile>> ReadPristineFilesAsync(
        string pluginName, string pluginPath, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default) =>
        SerializeToPristineFiles(OpenFor(pluginName, pluginPath, gameRelease, strings), pluginName, cancel);

    /// <summary>A plugin's binary as every record's own document plus the identity a source tree
    /// files it by. The mod is held here, so the caller never has one (ADR-0005 rule 2).</summary>
    internal static IEnumerable<(RecordIdentity Identity, string Text)> RecordDocumentsOf(
        string pluginName, string pluginPath, GameRelease gameRelease, PluginStrings strings,
        RecordTextCodec codec, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        ModDocuments.IdentifiedRecordsOf(
            OpenFor(pluginName, pluginPath, gameRelease, strings), codec, schemas);

    private static IMod OpenFor(
        string pluginName, string pluginPath, GameRelease gameRelease, PluginStrings strings) =>
        MutagenPluginAdapter.Instance.OpenForWrite(
            new ModPath(ModKey.FromFileName(pluginName), pluginPath), gameRelease, strings);

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

    /// <summary>The tree at <paramref name="treeRoot"/> read into the mod it compiles to, held here
    /// so the compile itself holds documents (ADR-0005 rule 2).</summary>
    internal static async Task<CompiledTree> ReadTreeAsync(
        string treeRoot, RecordTextCodec codec, GameRelease gameRelease, CancellationToken cancel = default) =>
        new(await DeserializeTree(treeRoot, cancel), codec, gameRelease);

    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];
}

/// <summary>One compile's source tree as the mod it becomes: the only box that mod lives in, which
/// answers the compile in header facts, FormKeys and documents.</summary>
internal sealed class CompiledTree(IMod mod, RecordTextCodec codec, GameRelease gameRelease)
{
    private readonly Lazy<IReadOnlyList<FormKey>> _formKeys =
        new(() => mod.EnumerateMajorRecords().Select(record => record.FormKey).ToList());

    /// <summary>The plugin the tree describes, which is whose records count as native.</summary>
    internal ModKey ModKey => mod.ModKey;

    /// <summary>The removable ESL header flag, as opposed to light by <c>.esl</c> extension.</summary>
    internal bool IsSmallMaster => mod.IsSmallMaster;

    internal bool IsLight(string fileName) => PluginFlagPredicates.IsLight(mod, fileName);

    /// <summary>The local FormID range an ESL-addressable plugin may use, or null when the header
    /// declares none.</summary>
    internal (uint Min, uint Max)? SmallMasterRange =>
        RecordCompactionCompatibilityDetection.GetSmallMasterRange(mod) is { } range
            ? (range.Min, range.Max)
            : null;

    /// <summary>Every record the tree holds, in the order the mod enumerates them.</summary>
    internal IReadOnlyList<FormKey> FormKeys => _formKeys.Value;

    /// <summary>Each record as its own document, under the schema table it belongs to. A record no
    /// table claims has no document, so nothing is derived from it.</summary>
    internal IEnumerable<PluginDocument> Documents(IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        foreach (var record in mod.EnumerateMajorRecords())
        {
            var recordType = RecordTableName.Of(record, schemas);
            if (!schemas.ContainsKey(recordType)) continue;
            yield return new PluginDocument(recordType, record.FormKey.ToString(), codec.SerializeToText(record, gameRelease));
        }
    }

    /// <summary>What the current codec would write for this mod, which is what the round-trip gate
    /// compares the tree against.</summary>
    internal Task<IReadOnlyList<PristineFile>> SerializeToPristineFilesAsync(string pluginName) =>
        PluginTrees.SerializeToPristineFiles(mod, pluginName);

    /// <summary>The mod handed straight to the write, through the backup-and-rename discipline
    /// every plugin replacement shares.</summary>
    internal Task<string> SaveThroughAsync(PluginWriter writer, string pluginPath, IReadOnlyList<string> loadOrder) =>
        writer.SaveFromModAsync(mod, pluginPath, loadOrder);
}
