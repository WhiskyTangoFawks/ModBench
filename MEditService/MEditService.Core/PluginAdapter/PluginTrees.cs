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
    /// <c>MissingStringsFile</c> names the localization file it declares and the disk has not, in
    /// which case there are no files.</summary>
    internal static async Task<(IReadOnlyList<TreeFile> Files, string? MissingStringsFile)> ReadAsync(
        ModPath modPath, string pluginName, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default)
    {
        var mod = OpenFor(modPath, gameRelease, strings);

        // Refuse by name before any serialize: TranslatedString.TryLookup returns false for a missing
        // file with no exception.
        return LocalizedStrings.FindMissingStringsFile(mod, pluginName, strings, gameRelease) is { } missing
            ? ([], missing)
            : (await SerializeTree(mod, cancel), null);
    }

    /// <summary>A plugin's binary re-serialized as its whole source tree, with no localization
    /// check: what a re-baseline of an already tracked plugin commits.</summary>
    internal static Task<IReadOnlyList<TreeFile>> ReadPristineFilesAsync(
        ModPath modPath, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default) =>
        SerializeTree(OpenFor(modPath, gameRelease, strings), cancel);

    /// <summary>A plugin's binary as every record's own document plus the identity a source tree
    /// files it by. The mod is held here, so the caller never has one (ADR-0005 rule 2).</summary>
    internal static IEnumerable<(RecordIdentity Identity, string Text)> RecordDocumentsOf(
        ModPath modPath, GameRelease gameRelease, PluginStrings strings,
        RecordTextCodec codec, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        ModDocuments.IdentifiedRecordsOf(OpenFor(modPath, gameRelease, strings), codec, schemas);

    private static IMod OpenFor(ModPath modPath, GameRelease gameRelease, PluginStrings strings) =>
        MutagenPluginAdapter.OpenForWrite(modPath, gameRelease, strings);

    /// <summary>One plugin's complete tree, ready to commit — the one implementation of the door's
    /// write. A second serializer that dropped the root RecordData.json would delete the header from
    /// the baseline.</summary>
    internal static async Task<IReadOnlyList<TreeFile>> SerializeTree(
        IModGetter mod, CancellationToken cancel = default)
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
            var treeFiles = new List<TreeFile>();
            foreach (var file in Directory.EnumerateFiles(scratchDir, "*", SearchOption.AllDirectories))
            {
                cancel.ThrowIfCancellationRequested();
                treeFiles.Add(new TreeFile(
                    Path.GetRelativePath(scratchDir, file),
                    StripCarriageReturns(await File.ReadAllBytesAsync(file, cancel))));
            }
            return treeFiles;
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }

    /// <summary>The tree in <paramref name="files"/> compiled to bytes at
    /// <paramref name="destinationPath"/>, with neither backup nor rename: a scratch verification must
    /// not drop a .bak beside the real plugin.</summary>
    internal static async Task WriteFromTreeAsync(
        IReadOnlyList<PristineFile> files, string destinationPath, TreeDeserializer? deserialize = null,
        CancellationToken cancel = default)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-writetree-").FullName;
        try
        {
            var recompiled = await (deserialize ?? DeserializeTree)(
                await MaterializeTree(files, scratchDir, cancel), cancel);
            await MutagenPluginAdapter.WriteAsync(recompiled, destinationPath);
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }

    // The files written under baseDirectory, answering the root the door reads from.
    private static async Task<string> MaterializeTree(
        IReadOnlyList<PristineFile> files, string baseDirectory, CancellationToken cancel)
    {
        foreach (var file in files)
        {
            var fullPath = Path.Combine(baseDirectory, file.RelativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
            await File.WriteAllBytesAsync(fullPath, file.Content, cancel);
        }
        return Path.Combine(baseDirectory, SharedDirectoryOf(files));
    }

    // Every file of one plugin's tree sits under that tree's root, so their common directory is it.
    // Nothing here spells that root: where a tree lives in a mod folder is the repository's layout.
    private static string SharedDirectoryOf(IReadOnlyList<PristineFile> files)
    {
        var shared = Path.GetDirectoryName(files.Count > 0 ? files[0].RelativePath : "") ?? "";
        foreach (var file in files)
        {
            var directory = Path.GetDirectoryName(file.RelativePath) ?? "";
            while (shared.Length > 0
                   && !directory.Equals(shared, StringComparison.Ordinal)
                   && !directory.StartsWith(shared + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                shared = Path.GetDirectoryName(shared) ?? "";
            }
        }
        return shared;
    }

    private static async Task<IMod> DeserializeTree(string treeRoot, CancellationToken cancel) =>
        await RecordTextCodecGeneratorSeed.DeserializeWholeMod(treeRoot, InlineWorkDropoff.Instance, cancel);

    /// <summary>The codec's verdict on the plugin written at <paramref name="recompiledPath"/> against
    /// the one at <paramref name="modPath"/>; null when they are model-identical. Both are
    /// reparsed, since only written bytes show what the writer does.</summary>
    internal static ModelIdentity.Divergence? DivergenceBetween(
        ModPath modPath, string recompiledPath, GameRelease gameRelease, PluginStrings strings)
    {
        var original = MutagenPluginAdapter.OpenForWrite(modPath, gameRelease, strings);
        var recompiled = MutagenPluginAdapter.OpenForWrite(
            new ModPath(modPath.ModKey, recompiledPath), gameRelease);

        return ModelIdentity.FindFirstDivergence(original, recompiled);
    }

    /// <summary>The prefix of the scratch folder a whole-mod read materializes its files in, so a test
    /// watching for a leak knows what to look for.</summary>
    internal const string ReadScratchPrefix = "medit-readtree-";

    /// <summary>One source tree's files read into the mod they compile to, in a scratch folder of the
    /// door's own. The mod is held in the tree, so the compile holds documents (ADR-0005 rule
    /// 2).</summary>
    internal static async Task<(CompiledTree? Tree, PluginDiagnosis? Diagnosis, Exception? Error)> ReadTreeAsync(
        IReadOnlyList<PristineFile> files, RecordTextCodec codec, GameRelease gameRelease,
        CancellationToken cancel = default)
    {
        var scratchDir = Directory.CreateTempSubdirectory(ReadScratchPrefix).FullName;
        try
        {
            // Outside the catch below: a tree git holds and this filesystem cannot write is not a
            // source defect, and a refusal naming the source would misname it.
            var treeRoot = await MaterializeTree(files, scratchDir, cancel);

            // The files carry their own mod-folder-relative paths, so the scratch is a mod folder and
            // every path a read failure names is relative to one.
            try
            {
                var mod = await DeserializeTree(treeRoot, cancel);
                return (new CompiledTree(mod, codec, gameRelease), null, null);
            }
            catch (Exception ex)
            {
                return (null, PluginDiagnosis.FromSourceReadException(ex, scratchDir), ex);
            }
        }
        finally
        {
            // Best-effort: a scratch folder that will not delete must not turn a compile that has
            // already read its mod into a throw.
            try { Directory.Delete(scratchDir, recursive: true); }
            catch (IOException) { /* scratch, best-effort */ }
            catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
        }
    }

    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];
}

/// <summary>One compile's source tree as the mod it becomes: the only box that mod lives in, which
/// answers the compile in header facts, FormKeys and documents.</summary>
public sealed class CompiledTree
{
    private readonly IMod _mod;
    private readonly RecordTextCodec _codec;
    private readonly GameRelease _gameRelease;
    private readonly Lazy<IReadOnlyList<FormKey>> _formKeys;

    internal CompiledTree(IMod mod, RecordTextCodec codec, GameRelease gameRelease)
    {
        _mod = mod;
        _codec = codec;
        _gameRelease = gameRelease;
        _formKeys = new Lazy<IReadOnlyList<FormKey>>(
            () => mod.EnumerateMajorRecords().Select(record => record.FormKey).ToList());
    }

    /// <summary>The plugin the tree describes, which is whose records count as native.</summary>
    public ModKey ModKey => _mod.ModKey;

    /// <summary>The removable ESL header flag, as opposed to light by <c>.esl</c> extension.</summary>
    public bool IsSmallMaster => _mod.IsSmallMaster;

    public bool IsLight(string fileName) => PluginFlagPredicates.IsLight(_mod, fileName);

    /// <summary>The local FormID range an ESL-addressable plugin may use, or null when the header
    /// declares none.</summary>
    public (uint Min, uint Max)? SmallMasterRange =>
        RecordCompactionCompatibilityDetection.GetSmallMasterRange(_mod) is { } range
            ? (range.Min, range.Max)
            : null;

    /// <summary>Every record the tree holds, in the order the mod enumerates them.</summary>
    public IReadOnlyList<FormKey> FormKeys => _formKeys.Value;

    /// <summary>Each record as its own document, under the schema table it belongs to. A record no
    /// table claims has no document, so nothing is derived from it.</summary>
    public IEnumerable<PluginDocument> Documents(IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        foreach (var record in _mod.EnumerateMajorRecords())
        {
            var recordType = RecordTableName.Of(record, schemas);
            if (!schemas.ContainsKey(recordType)) continue;
            yield return new PluginDocument(recordType, record.FormKey.ToString(), _codec.SerializeToText(record, _gameRelease));
        }
    }

    /// <summary>What the current codec would write for this mod, which is what the round-trip gate
    /// compares the tree against.</summary>
    public Task<IReadOnlyList<TreeFile>> SerializeTreeAsync() => PluginTrees.SerializeTree(_mod);

    /// <summary>The mod handed straight to the write, through the backup-and-rename discipline
    /// every plugin replacement shares.</summary>
    public Task<string> SaveThroughAsync(PluginWriter writer, string pluginPath, IReadOnlyList<string> loadOrder) =>
        writer.SaveFromModAsync(_mod, pluginPath, loadOrder);
}
