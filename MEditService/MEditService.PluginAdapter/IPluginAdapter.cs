using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter;

/// <summary>Bytes to documents and facts and back (ADR-0005). The game release is a
/// parameter of every verb.</summary>
public interface IPluginAdapter
{
    /// <summary>The plugin as the documents its source tree would hold (ADR-0007). Owns the open
    /// until the result is disposed; omitting <paramref name="strings"/> is not neutral for a
    /// localized plugin.</summary>
    IPluginDocuments OpenDocuments(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null);

    /// <summary>The same plugin for a caller asking about a handful of records by key rather than
    /// streaming all of them. Owns the open until the result is disposed.</summary>
    IPluginRecordLookup OpenRecordLookup(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas);

    /// <summary>Whether the plugin's file opens for reading right now — it is there, and no other
    /// tool holds it against a reader. Neither a read of its bytes nor a parse.</summary>
    bool CanRead(ModPath modPath);

    /// <summary>What a plugin's own binary says about itself, which is what the Index holds for it.
    /// <c>Unreachable</c> is the throw that stopped a full walk: the count is a readout, not a
    /// gate.</summary>
    (PluginContent Content, Exception? Unreachable) ReadContent(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null);

    /// <summary>What each of <paramref name="formKeys"/> names in the files at
    /// <paramref name="loadOrder"/>, as the game resolves it, beside the unreadable files. The link
    /// cache is built and dropped here (ADR-0005).</summary>
    LinkAnswers LinkTargets(
        IReadOnlyList<ModPath> loadOrder,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        IReadOnlyCollection<string> formKeys);

    // A source tree's root is the plugin's name as the load order spells it, so registeredName
    // travels beside the path: a ModKey renders the extension from Mutagen's lowercase constants.

    /// <summary>One source tree compiled to the mod it describes, which the tree holds so the caller
    /// does not (ADR-0005). A tree that will not read answers with its diagnosis.</summary>
    Task<(CompiledTree? Tree, PluginDiagnosis? Diagnosis, Exception? Error)> ReadTreeAsync(
        IReadOnlyList<TreeFile> files,
        RecordTextCodec codec,
        GameRelease gameRelease,
        CancellationToken cancel = default);

    /// <summary>The tree in <paramref name="files"/> compiled to bytes at
    /// <paramref name="destinationPath"/>, in place with no rename: a scratch verification, never a
    /// replacement of the real plugin.</summary>
    Task WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, CancellationToken cancel = default);

    /// <summary>A plugin's binary read as the source tree it would commit.
    /// <c>MissingStringsFile</c> names the localization file it declares and the disk has not, in
    /// which case there are no files.</summary>
    Task<(IReadOnlyList<TreeFile> Files, string? MissingStringsFile)> ReadSourceAsync(
        ModPath modPath, string registeredName, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default);

    /// <summary>The same binary re-serialized with no localization check.</summary>
    Task<IReadOnlyList<TreeFile>> ReadPristineFilesAsync(
        ModPath modPath, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default);

    /// <summary>How the plugin at <paramref name="recompiledPath"/> differs from the one at
    /// <paramref name="modPath"/> as the codec models them; null when they are model-identical. Both
    /// are reparsed, since only written bytes show what the writer does.</summary>
    string? DivergenceBetween(
        ModPath modPath, string recompiledPath, GameRelease gameRelease, PluginStrings strings);

    /// <summary>How the file at <paramref name="recompiledPath"/> differs at the byte level from the one
    /// at <paramref name="originalPath"/>. Throws when either cannot be read.</summary>
    Task<PluginByteComparison> CompareBytesAsync(
        string originalPath, string recompiledPath, CancellationToken cancel = default);

    /// <summary>A new plugin in <paramref name="folder"/>: a header whose flags the extension alone
    /// sets, no records and no masters. Written whole or not at all, into no folder it made and over
    /// no file.</summary>
    Task<EmptyPluginWrite> CreateAndWriteAsync(ModKey modKey, string folder, GameRelease gameRelease);
}

/// <summary>What <see cref="IPluginAdapter.CreateAndWriteAsync"/> found at the path before it wrote
/// anything, or that it wrote.</summary>
public enum EmptyPluginWrite
{
    Written,
    FolderGone,
    FileExists,
}

/// <summary>Whether two plugin files hold the same bytes. If not, <c>Loss</c> is the first record whose
/// rewrite dropped subrecords and <c>LossCause</c> the original's diagnosis of it, if any.</summary>
public sealed record PluginByteComparison(
    bool Identical, PluginBinaryWalk.SubrecordLoss? Loss = null, PluginDiagnosis? LossCause = null);
