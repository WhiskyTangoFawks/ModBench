using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Repair;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog.WorkEngine;

namespace MEditService.PluginAdapter;

/// <summary>A plugin's binary and its source tree, composed: the codec's whole-mod door on one side
/// and this adapter's open and write on the other, so no caller holds the live mod between
/// them.</summary>
internal static class PluginTrees
{
    /// <summary>A plugin's own binary read as the documents its tree would hold.</summary>
    internal static async Task<Answer<PluginSource, PluginFailure>> ReadAsync(
        ModPath modPath, LoadOrderSnapshot loadOrder, PluginStrings strings, Language language,
        CancellationToken cancel = default)
    {
        var gameRelease = loadOrder.GameRelease;
        try
        {
            // Hashed before the read: bytes another tool writes after it are then named as an external
            // change, never taken for the bytes this tree came from.
            var binarySha256 = PluginBinaryHash.TrailerFormOfFile(modPath.Path);
            var mod = MutagenPluginAdapter.OpenForWrite(modPath, gameRelease, strings, loadOrder, language);

            // Refuse by name before any serialize: TranslatedString.TryLookup returns false for a missing
            // file with no exception.
            if (LocalizedStrings.FindMissingStringsFile(mod, modPath, strings, loadOrder, gameRelease, language) is { } missing)
                return new PluginFailure.MissingStrings(missing);
            if (mod.EnumerateMajorRecords().FirstOrDefault(record => record.FormKey.IsNull || record.FormKey == new FormKey(mod.ModKey, 0)) is { } objectIdZero)
            {
                var signature = RecordTypes.For(gameRelease).RecordTypeOf(objectIdZero).ToUpperInvariant();
                return objectIdZero.FormKey.IsNull
                    ? new PluginFailure.NullFormIdHeld(signature)
                    : new PluginFailure.HeaderFormKeyHeld(signature, objectIdZero.FormKey);
            }
            return PluginAnswer.Of(new PluginSource(
                await SerializeTree(mod, cancel), [.. mod.MasterReferences.Select(reference => reference.Master.FileName.ToString())], binarySha256));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            PluginFailure.ThrowIfNotTheFilesAnswer(ex, new PluginRecordBytes(modPath, loadOrder));
            var failure = PluginFailure.Of(ex);
            return failure is PluginFailure.Unparsed unparsed
                ? (PluginFailure)unparsed.ScannedFor(failing => MalformationsAt(failing, modPath, loadOrder))
                : failure;
        }
    }

    // The failing record's diagnoses, matched as the loss branch of CompareBytesAsync matches its own.
    private static IReadOnlyList<RepairPreview> MalformationsAt(PluginDiagnosis failing, ModPath modPath, LoadOrderSnapshot loadOrder)
    {
        var masters = PluginBinaryWalk.MastersOf(modPath, loadOrder);
        bool Names(Malformations.Found found)
        {
            var formKey = masters.GetFormKey(found.Record.FormID, reference: false).ToString();
            return failing.Anchor is { } anchor && (anchor.EndsWith($" {formKey}", StringComparison.Ordinal) || anchor.Contains($" {formKey} ", StringComparison.Ordinal));
        }

        return [.. Malformations.In(File.ReadAllBytes(modPath.Path), loadOrder.GameRelease).Where(Names).Select(found => found.Preview)];
    }

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
            await GameCodecs.For(mod.GameRelease).SerializeWholeMod(mod, scratchDir, InlineWorkDropoff.Instance, cancel);

            // Newtonsoft's JsonTextWriter has no reachable NewLine to pin, so line endings are canonicalized
            // after the write, as the per-record codec does.
            var treeFiles = new List<TreeFile>();
            foreach (var file in Directory.EnumerateFiles(scratchDir, "*", SearchOption.AllDirectories))
            {
                cancel.ThrowIfCancellationRequested();
                treeFiles.Add(new TreeFile(
                    Path.GetRelativePath(scratchDir, file),
                    TranslatedStringValues.InLanguageOrder(StripCarriageReturns(await File.ReadAllBytesAsync(file, cancel)))));
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
    internal static async Task<Answer<string, PluginFailure>> WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, IReadOnlyList<string> masterOrder, LoadOrderSnapshot loadOrder,
        CancellationToken cancel = default)
    {
        var game = GameCodecs.For(loadOrder.GameRelease);
        var scratchDir = Directory.CreateTempSubdirectory("medit-writetree-").FullName;
        try
        {
            if (!(await ReadIntoAsync(game, files, scratchDir, cancel)).Holds(out var recompiled, out var unread)) return unread;
            if (!MasterStyles.Of(masterOrder.Select(name => ModKey.FromFileName(name)), loadOrder).Holds(out var styles, out unread)) return unread;
            await MutagenPluginAdapter.WriteAsync(recompiled, destinationPath, masterOrder, styles);
            return PluginAnswer.Of(destinationPath);
        }
        catch (Exception ex) when (PluginFailure.OfWrite(ex) is { } failure)
        {
            return failure;
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }

    // Mutagen takes a ModKey from a folder's name before a header's, and Windows names a temp folder with a
    // random extension, now and then .esp, .esm or .esl.
    private const string TreeFolder = "tree";

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

    // The mod files compile to, read in scratchDir, or the failure that names the file at fault.
    private static async Task<Answer<IMod, PluginFailure>> ReadIntoAsync(
        IGameCodec game, IReadOnlyList<TreeFile> files, string scratchDir, CancellationToken cancel)
    {
        // Outside the catch below: a scratch folder this filesystem cannot write is not a source
        // defect, and a refusal naming the source would misname it.
        var treeBase = Path.Combine(scratchDir, TreeFolder);
        var treeRoot = await MaterializeTree(files, treeBase, cancel);

        // The files carry their own mod-folder-relative paths, so the scratch is a mod folder and
        // every path a read failure names is relative to one.
        try
        {
            return PluginAnswer.Of(await DeserializeTree(game, treeRoot, cancel));
        }
        catch (Exception ex) when (OutOfMemoryOrCancellation.In(ex) is null)
        {
            return new PluginFailure.Unparsed(PluginDiagnosis.FromSourceReadException(ex, treeBase), ex);
        }
    }

    private static async Task<IMod> DeserializeTree(IGameCodec game, string treeRoot, CancellationToken cancel) =>
        HeaderDocument.RestoreOmittedNextObjectId(
            await game.DeserializeWholeMod(treeRoot, InlineWorkDropoff.Instance, cancel, NameOrderedFileSystem.Instance),
            await File.ReadAllBytesAsync(Path.Combine(treeRoot, DocumentFileNames.Root), cancel));

    /// <summary>The codec's verdict on the plugin written at <paramref name="recompiledPath"/> against
    /// the one at <paramref name="modPath"/>; null when they are model-identical. Both are
    /// reparsed, since only written bytes show what the writer does.</summary>
    internal static ModelIdentity.Divergence? DivergenceBetween(
        ModPath modPath, string recompiledPath, LoadOrderSnapshot loadOrder, PluginStrings strings, Language language)
    {
        var original = MutagenPluginAdapter.OpenForWrite(modPath, loadOrder.GameRelease, strings, loadOrder, language);
        var recompiled = MutagenPluginAdapter.OpenForWrite(
            new ModPath(modPath.ModKey, recompiledPath), loadOrder.GameRelease, loadOrder: loadOrder);

        return ModelIdentity.FindFirstDivergence(original, recompiled);
    }

    private const string ReadScratchPrefix = "medit-readtree-";

    /// <summary>One source tree's files read into the mod they compile to, in a scratch folder of the
    /// door's own. The mod is held in the tree, so the compile holds documents (ADR-0005).</summary>
    internal static async Task<Answer<CompiledTree, PluginFailure>> ReadTreeAsync(
        IReadOnlyList<TreeFile> files, LoadOrderSnapshot loadOrder, Language language,
        CancellationToken cancel = default)
    {
        // Outside the catch below: a game the service was not wired for is no source defect.
        var game = GameCodecs.For(loadOrder.GameRelease);
        var scratchDir = Directory.CreateTempSubdirectory(ReadScratchPrefix).FullName;
        try
        {
            return (await ReadIntoAsync(game, files, scratchDir, cancel)).Then(mod => PluginAnswer.Of(new CompiledTree(mod, loadOrder, language)));
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
    private readonly LoadOrderSnapshot _loadOrder;
    private readonly Language _language;
    private readonly Lazy<IReadOnlyList<FormKey>> _formKeys;
    private readonly Lazy<IReadOnlyList<(IMajorRecordGetter Record, PluginDocument Document)>> _documents;

    internal CompiledTree(IMod mod, LoadOrderSnapshot loadOrder, Language language)
    {
        _mod = mod;
        _loadOrder = loadOrder;
        _language = language;
        var gameRelease = loadOrder.GameRelease;
        _formKeys = new Lazy<IReadOnlyList<FormKey>>(
            () => mod.EnumerateMajorRecords().Select(record => record.FormKey).ToList());
        _documents = new Lazy<IReadOnlyList<(IMajorRecordGetter, PluginDocument)>>(
            () => [.. mod.EnumerateMajorRecords().Select(record => ((IMajorRecordGetter)record, new PluginDocument(
                RecordTypes.For(gameRelease).RecordTypeOf(record), record.FormKey.ToString(), RecordTextCodec.SerializeToText(record, gameRelease))))]);
    }

    /// <summary>The plugin the tree describes, which is whose records count as native.</summary>
    public ModKey ModKey => _mod.ModKey;

    /// <summary>The local FormIDs the tree's header flag limits its native records to, or null for a
    /// plugin no flag limits.</summary>
    public FormIdLimit? FormIdLimit(string fileName) => PluginFlags.LimitOf(_mod, fileName);

    /// <summary>Every record the tree holds, in the order the mod enumerates them.</summary>
    public IReadOnlyList<FormKey> FormKeys => _formKeys.Value;

    /// <summary>Each record as its own document, under the schema table it belongs to.</summary>
    public IEnumerable<PluginDocument> Documents() => _documents.Value.Select(held => held.Document);

    /// <summary>What the current codec would write for this mod, which is what the round-trip gate
    /// compares the tree against.</summary>
    public Task<IReadOnlyList<TreeFile>> SerializeTreeAsync() => PluginTrees.SerializeTree(_mod);

    /// <summary>Every value of the tree that <paramref name="save"/>'s bytes do not hold.</summary>
    public IReadOnlyList<DroppedValue> DropsIn(PreparedPluginSave save)
    {
        var written = save.Reread(_mod.ModKey, _loadOrder.GameRelease, _language);
        var held = _documents.Value.Select(pair => (pair.Record, pair.Document.Text)).ToList();
        return [.. ModelIdentity.FindDrops(held, written).Select(drop => new DroppedValue(
            new RecordIdentity(drop.Record.FormKey.ToString(), RecordTypes.For(_loadOrder.GameRelease).RecordTypeOf(drop.Record), drop.Record.EditorID),
            drop.Paths))];
    }

    /// <summary>The mod written to a temp file beside <paramref name="pluginPath"/> for
    /// <paramref name="land"/> to Commit into place, and discarded once it returns. Only the styles
    /// of <paramref name="masters"/>, the plugins the tree references, are read.</summary>
    public async Task<Answer<T, PluginFailure>> SaveAsync<T>(
        string pluginPath, IReadOnlyList<string> masterOrder, IEnumerable<string> masters, Func<PreparedPluginSave, T> land)
    {
        if (!MasterStyles.Of(masters.Select(name => ModKey.FromFileName(name)), _loadOrder).Holds(out var styles, out var unread)) return unread;
        var landing = false;
        try
        {
            using var save = await PluginWriter.PrepareFromModAsync(_mod, pluginPath, masterOrder, styles);
            landing = true;
            return PluginAnswer.Of(land(save));
        }
        // A throw out of land is the caller's own, never the write's.
        catch (Exception ex) when (!landing && PluginFailure.OfWrite(ex) is { } failure)
        {
            return failure;
        }
    }
}

/// <summary>A tree's record and each path in its document whose value the plugin written from it lacks.</summary>
public sealed record DroppedValue(RecordIdentity Record, IReadOnlyList<string> Paths);
