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
        RegisteredPlugin plugin,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas);

    /// <summary>Whether the plugin's file opens for reading right now — it is there, and no other
    /// tool holds it against a reader. Neither a read of its bytes nor a parse.</summary>
    bool CanRead(RegisteredPlugin plugin);

    bool Exists(string pluginPath);

    /// <summary>The content hash of the plugin file, kept by its stamp (ADR-0003). Null when the
    /// file cannot be read: no evidence either way, so each caller decides.</summary>
    string? HashOf(string pluginPath);

    /// <summary>The hash and malformed-record diagnoses from one read of the file, freshly read.
    /// Null on <see cref="HashOf"/>'s no-evidence terms.</summary>
    FileClaim? ClaimOf(string pluginPath);

    bool GameFolderExists(string gameFolder);

    /// <summary>What a plugin's own binary says about itself, which is what the Index holds for it.
    /// <c>Unreachable</c> is the throw that stopped a full walk: the count is a readout, not a
    /// gate.</summary>
    (PluginContent Content, Exception? Unreachable) ReadContent(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null);

    /// <summary>What each of <paramref name="formKeys"/> names in the files the game loads (ADR-0013), or in every
    /// plugin when it does not load <paramref name="compiled"/>, beside the unreadable files (ADR-0005).</summary>
    LinkAnswers LinkTargets(
        LoadOrderSnapshot loadOrder,
        RegisteredPlugin compiled,
        IReadOnlyCollection<string> formKeys);

    // A source tree's root is the plugin's name as the load order spells it, so registeredName
    // travels beside the path: a ModKey renders the extension from Mutagen's lowercase constants.

    /// <summary>One source tree compiled to the mod it describes, which the tree holds so the caller
    /// does not (ADR-0005). A tree that will not read answers with its diagnosis.</summary>
    Task<(CompiledTree? Tree, PluginDiagnosis? Diagnosis, Exception? Error)> ReadTreeAsync(
        IReadOnlyList<TreeFile> files,
        GameRelease gameRelease,
        CancellationToken cancel = default);

    /// <summary>The tree in <paramref name="files"/> compiled to a scratch plugin, its masters in
    /// <paramref name="masterOrder"/> (ADR-0008). Null once written, or the diagnosis of a write that
    /// pruned a master it still needed.</summary>
    Task<PluginDiagnosis?> WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, IReadOnlyList<string> masterOrder,
        CancellationToken cancel = default);

    /// <summary>A plugin's binary read as the source tree it would commit.</summary>
    Task<PluginSourceRead> ReadSourceOfAsync(
        RegisteredPlugin plugin, GameRelease gameRelease, PluginStrings strings, CancellationToken cancel = default);

    /// <summary>How the plugin at <paramref name="recompiledPath"/> differs from the named one as the
    /// codec models them; null when they are model-identical. Both are reparsed, since only written
    /// bytes show what the writer does.</summary>
    string? DivergenceFrom(
        string pluginFileName, string pluginFilePath, string recompiledPath, GameRelease gameRelease, PluginStrings strings);

    /// <summary>How the file at <paramref name="recompiledPath"/> differs at the byte level from the one
    /// at <paramref name="originalPath"/>. Throws when either cannot be read.</summary>
    Task<PluginByteComparison> CompareBytesAsync(
        string originalPath, string recompiledPath, CancellationToken cancel = default);

    /// <summary>A new plugin in <paramref name="folder"/>: a header whose flags the extension alone
    /// sets, no records and no masters. Written whole or not at all, into no folder it made and over
    /// no file.</summary>
    Task<EmptyPluginCreated> CreateAndWriteAsync(ModKey modKey, string folder, GameRelease gameRelease);

    /// <summary>Where <see cref="CreateAndWriteAsync"/> puts the plugin.</summary>
    string PathOfEmpty(ModKey modKey, string folder);

    /// <summary>Deletes the plugin <see cref="CreateAndWriteAsync"/> wrote, only while it still holds the
    /// bytes that call wrote, as <paramref name="written"/> hashes them (ADR-0003): a file another program changed is left as it is.</summary>
    EmptyPluginTakeBack TakeBackEmpty(ModKey modKey, string folder, string written);
}

/// <summary>What <see cref="IPluginAdapter.TakeBackEmpty"/> did.</summary>
public enum EmptyPluginTakeBack
{
    TakenBack,
    Gone,

    /// <summary>The file holds other bytes than the create wrote, or this adapter did not write it, so it stayed.</summary>
    Changed,
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

/// <summary>What <see cref="IPluginAdapter.CreateAndWriteAsync"/> did, and for a plugin it wrote, the
/// hash of those bytes, which the take-back is later handed.</summary>
public readonly record struct EmptyPluginCreated(EmptyPluginWrite Outcome, string Written = "")
{
    public static implicit operator EmptyPluginCreated(EmptyPluginWrite outcome) => new(outcome);
}
