using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter;

/// <summary>Bytes to documents and facts and back (ADR-0005). The game release is a
/// parameter of every verb, and a read or write Mutagen cannot make answers its failure (ADR-0019).</summary>
public interface IPluginAdapter
{
    /// <summary>The plugin as the documents its source tree would hold (ADR-0007). Owns the open
    /// until the result is disposed; omitting <paramref name="strings"/> is not neutral for a
    /// localized plugin.</summary>
    Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null);

    /// <summary>The same plugin for a caller asking about a handful of records by key rather than
    /// streaming all of them. Owns the open until the result is disposed.</summary>
    Answer<IPluginRecords, PluginFailure> OpenRecordLookup(
        RegisteredPlugin plugin,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas);

    bool Exists(string pluginPath);

    /// <summary>The content hash of the plugin file, kept by its stamp (ADR-0003). Null when the
    /// file cannot be read: no evidence either way, so each caller decides.</summary>
    string? HashOf(string pluginPath);

    /// <summary>Forgets the hash of every file but <paramref name="pluginPaths"/>.</summary>
    void KeepHashesOf(IReadOnlySet<string> pluginPaths);

    /// <summary>The hash and malformed-record diagnoses from one fresh read of the file.</summary>
    Answer<FileClaim, PluginFailure> ClaimOf(string pluginPath);

    bool GameFolderExists(string gameFolder);

    /// <summary>What a plugin's own binary says about itself, which is what the Index holds for it.
    /// <c>Unreachable</c> stopped a full walk: the count is a readout, not a gate.</summary>
    Answer<(PluginContent Content, PluginFailure? Unreachable), PluginFailure> ReadContent(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null);

    /// <summary>What each of <paramref name="formKeys"/> names in the files the game loads (ADR-0013), or in every
    /// plugin when it does not load <paramref name="compiled"/>, beside the unreadable files (ADR-0005).</summary>
    LinkAnswers LinkTargets(
        LoadOrderSnapshot loadOrder,
        RegisteredPlugin compiled,
        IReadOnlyCollection<string> formKeys);

    /// <summary>One source tree compiled to the mod it describes, which the tree holds so the caller
    /// does not (ADR-0005).</summary>
    Task<Answer<CompiledTree, PluginFailure>> ReadTreeAsync(
        IReadOnlyList<TreeFile> files,
        GameRelease gameRelease,
        CancellationToken cancel = default);

    /// <summary>The tree in <paramref name="files"/> compiled to <paramref name="destinationPath"/>,
    /// its masters in <paramref name="masterOrder"/> (ADR-0008). Answers the path it wrote.</summary>
    Task<Answer<string, PluginFailure>> WriteFromTreeAsync(
        IReadOnlyList<TreeFile> files, string destinationPath, IReadOnlyList<string> masterOrder,
        CancellationToken cancel = default);

    /// <summary>A plugin's binary read as the source tree it would commit.</summary>
    Task<Answer<PluginSource, PluginFailure>> ReadSourceOfAsync(
        RegisteredPlugin plugin, GameRelease gameRelease, PluginStrings strings, CancellationToken cancel = default);

    /// <summary>How the plugin at <paramref name="recompiledPath"/> differs from the named one as the
    /// codec models them; null when they are model-identical. Both are reparsed, since only written
    /// bytes show what the writer does.</summary>
    Answer<string?, PluginFailure> DivergenceFrom(
        string pluginFileName, string pluginFilePath, string recompiledPath, GameRelease gameRelease, PluginStrings strings);

    /// <summary>How the file at <paramref name="recompiledPath"/> differs at the byte level from the one
    /// at <paramref name="originalPath"/>.</summary>
    Task<Answer<PluginByteComparison, PluginFailure>> CompareBytesAsync(
        string originalPath, string recompiledPath, CancellationToken cancel = default);

    /// <summary>A new plugin in <paramref name="folder"/>: a header whose flags the extension alone
    /// sets, no records and no masters. Written whole or not at all, into no folder it made and over
    /// no file.</summary>
    Task<Answer<EmptyPluginCreated, PluginFailure>> CreateAndWriteAsync(ModKey modKey, string folder, GameRelease gameRelease);

    /// <summary>Where <see cref="CreateAndWriteAsync"/> puts the plugin.</summary>
    string PathOfEmpty(ModKey modKey, string folder);

    /// <summary>Deletes the plugin <see cref="CreateAndWriteAsync"/> wrote, only while it still holds the
    /// bytes that call wrote, as <paramref name="written"/> hashes them (ADR-0003): a file another program changed is left as it is.</summary>
    Answer<EmptyPluginTakeBack, PluginFailure> TakeBackEmpty(ModKey modKey, string folder, string written);
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
