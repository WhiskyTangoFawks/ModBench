using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Analysis;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.PluginAdapter;

/// <summary>A plugin's binary and its source tree, composed: the codec's whole-mod door on one side
/// and this adapter's open and write on the other, so no caller holds the live mod between
/// them.</summary>
internal static class PluginTrees
{
    /// <summary>A plugin's own binary read as the documents its tree would hold.</summary>
    internal static async Task<PluginSourceRead> ReadAsync(
        ModPath modPath, string pluginName, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default)
    {
        try
        {
            // Hashed before the read: bytes another tool writes after it are then named as an external
            // change, never taken for the bytes this tree came from.
            var binarySha256 = PluginBinaryHash.TrailerFormOfFile(modPath.Path);
            var mod = OpenFor(modPath, gameRelease, strings);

            // Refuse by name before any serialize: TranslatedString.TryLookup returns false for a missing
            // file with no exception.
            return LocalizedStrings.FindMissingStringsFile(mod, pluginName, strings, gameRelease) is { } missing
                ? new PluginSourceRead.MissingStrings(missing)
                : new PluginSourceRead.Read(await SerializeTree(mod, cancel), binarySha256);
        }
        catch (Exception ex) when (ex is not (OutOfMemoryException or OperationCanceledException))
        {
            return new PluginSourceRead.Unparsed(PluginDiagnosis.FromParseException(ex), ex);
        }
    }

    private static IMod OpenFor(ModPath modPath, GameRelease gameRelease, PluginStrings strings) =>
        MutagenPluginAdapter.OpenForWrite(modPath, gameRelease, strings);

    /// <summary>One plugin's complete tree, ready to commit — the one implementation of the door's
    /// write. A second serializer that dropped the root RecordData.json would delete the header from
    /// the commit.</summary>
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
    /// <paramref name="destinationPath"/>, in place with no rename: a scratch verification, never a
    /// replacement of the real plugin.</summary>
    internal static async Task<PluginDiagnosis?> WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, IReadOnlyList<string> masterOrder,
        CancellationToken cancel = default)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-writetree-").FullName;
        try
        {
            var recompiled = await DeserializeTree(
                await MaterializeTree(files, scratchDir, cancel), cancel);
            await MutagenPluginAdapter.WriteAsync(recompiled, destinationPath, masterOrder);
            return null;
        }
        catch (Exception ex) when (PrunedAMasterItNeeded(ex))
        {
            return PluginDiagnosis.FromWriteException(ex);
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }

    // ADR-0008's content-derived master pass prunes a master a write still needs when its only
    // reference sits in a VMAD struct-list property, which Mutagen never walks (upstream issue 688).
    // Every other write failure propagates.
    internal static bool PrunedAMasterItNeeded(Exception ex) => PluginDiagnosis.HasUnmappableFormID(ex);

    // The files written under baseDirectory, answering the root the door reads from.
    private static async Task<string> MaterializeTree(
        IReadOnlyList<TreeFile> files, string baseDirectory, CancellationToken cancel)
    {
        foreach (var file in files)
        {
            var fullPath = Path.Combine(baseDirectory, file.RelativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath)
                ?? throw new InvalidOperationException($"Expected '{fullPath}' to have a parent directory."));
            await File.WriteAllBytesAsync(fullPath, file.Content, cancel);
        }
        return Path.Combine(baseDirectory, SharedDirectoryOf(files));
    }

    // Every file of one plugin's tree sits under that tree's root, so their common directory is it.
    // Nothing here spells that root: where a tree lives in a mod folder is the repository's layout.
    private static string SharedDirectoryOf(IReadOnlyList<TreeFile> files)
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

    private const string ReadScratchPrefix = "medit-readtree-";

    /// <summary>One source tree's files read into the mod they compile to, in a scratch folder of the
    /// door's own. The mod is held in the tree, so the compile holds documents (ADR-0005).</summary>
    internal static async Task<(CompiledTree? Tree, PluginDiagnosis? Diagnosis, Exception? Error)> ReadTreeAsync(
        IReadOnlyList<TreeFile> files, GameRelease gameRelease,
        CancellationToken cancel = default)
    {
        var scratchDir = Directory.CreateTempSubdirectory(ReadScratchPrefix).FullName;
        try
        {
            // Outside the catch below: a scratch folder this filesystem cannot write is not a source
            // defect, and a refusal naming the source would misname it.
            var treeRoot = await MaterializeTree(files, scratchDir, cancel);

            // The files carry their own mod-folder-relative paths, so the scratch is a mod folder and
            // every path a read failure names is relative to one.
            try
            {
                var mod = await DeserializeTree(treeRoot, cancel);
                return (new CompiledTree(mod, gameRelease), null, null);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
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
    private readonly GameRelease _gameRelease;
    private readonly Lazy<IReadOnlyList<FormKey>> _formKeys;

    internal CompiledTree(IMod mod, GameRelease gameRelease)
    {
        _mod = mod;
        _gameRelease = gameRelease;
        _formKeys = new Lazy<IReadOnlyList<FormKey>>(
            () => mod.EnumerateMajorRecords().Select(record => record.FormKey).ToList());
    }

    /// <summary>The plugin the tree describes, which is whose records count as native.</summary>
    public ModKey ModKey => _mod.ModKey;

    /// <summary>The removable ESL header flag, as opposed to light by <c>.esl</c> extension.</summary>
    internal bool IsSmallMaster => _mod.IsSmallMaster;

    public bool IsLight(string fileName) => PluginFlagPredicates.IsLight(_mod, fileName);

    /// <summary>The local FormID range an ESL-addressable plugin may use, or null when the header
    /// declares none.</summary>
    public (uint Min, uint Max)? SmallMasterRange =>
        RecordCompactionCompatibilityDetection.GetSmallMasterRange(_mod) is { } range
            ? (range.Min, range.Max)
            : null;

    /// <summary>Every record the tree holds, in the order the mod enumerates them.</summary>
    public IReadOnlyList<FormKey> FormKeys => _formKeys.Value;

    /// <summary>Each record as its own document, under the schema table it belongs to.</summary>
    public IEnumerable<PluginDocument> Documents() =>
        _mod.EnumerateMajorRecords().Select(record => new PluginDocument(
            RecordTypes.For(_gameRelease).RecordTypeOf(record), record.FormKey.ToString(), RecordTextCodec.SerializeToText(record, _gameRelease)));

    /// <summary>What the current codec would write for this mod, which is what the round-trip gate
    /// compares the tree against.</summary>
    public Task<IReadOnlyList<TreeFile>> SerializeTreeAsync() => PluginTrees.SerializeTree(_mod);

    /// <summary>The mod written to a temp file beside <paramref name="pluginPath"/>, which the
    /// returned save renames into place on Commit; or the diagnosis of a write that pruned a master it
    /// still needed.</summary>
    public async Task<(PreparedPluginSave? Save, PluginDiagnosis? Unmappable)> PrepareSaveAsync(
        string pluginPath, IReadOnlyList<string> loadOrder)
    {
        try
        {
            return (await PluginWriter.PrepareFromModAsync(_mod, pluginPath, loadOrder), null);
        }
        catch (Exception ex) when (PluginTrees.PrunedAMasterItNeeded(ex))
        {
            return (null, PluginDiagnosis.FromWriteException(ex));
        }
    }
}
