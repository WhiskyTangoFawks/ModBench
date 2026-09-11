using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.PluginAdapter;

/// <summary>A mod opened for reading, disposed when the caller is done with its bytes.</summary>
public interface ILoadedMod : IDisposable
{
    IModGetter Getter { get; }
}

/// <summary>The FormIDs a plugin's own binary already holds: its header document, and the keys
/// native to it, which is what an allocator may not draw again.</summary>
public readonly record struct PluginFormIds(string HeaderText, IReadOnlySet<string> Native);

/// <summary>Bytes to a live Mutagen mod and back (ADR-0005 rule 2). The game release is a parameter
/// of every verb, so no caller names a game to open or write a plugin.</summary>
public interface IPluginAdapter
{
    /// <summary>An overlay for reading. <paramref name="strings"/> is optional only for callers with
    /// nothing localization-specific to say: "pass nothing" is not neutral for a localized
    /// plugin.</summary>
    ILoadedMod OpenForRead(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null);

    /// <summary>The same plugin as the documents its source tree would hold (ADR-0007), for callers
    /// outside the codec/adapter pair. Owns the open until the result is disposed.</summary>
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

    /// <summary>What a plugin's own binary says about the FormIDs it holds: its header as a document
    /// (ADR-0007), and every FormKey native to it. No record becomes a document.</summary>
    PluginFormIds ReadFormIds(ModPath modPath, GameRelease gameRelease);

    /// <summary>Whether any record in the plugin links <paramref name="target"/>,
    /// <paramref name="itself"/> aside. The master list answers first: a plugin that does not master
    /// the target's origin cannot express a link to it.</summary>
    bool LinksTo(ModPath modPath, GameRelease gameRelease, FormKey target, FormKey? itself);

    /// <summary>A deep parse the caller may mutate, for the gestures that re-serialize or re-write a
    /// plugin. Same <paramref name="strings"/> rule as <see cref="OpenForRead"/>.</summary>
    IMod OpenForWrite(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null);

    /// <summary>An empty mod of <paramref name="gameRelease"/>'s own type, carrying nothing but its
    /// header.</summary>
    IMod CreateEmpty(ModKey modKey, GameRelease gameRelease);

    /// <summary>A brand-new plugin at <paramref name="destinationPath"/>, header and nothing else.
    /// Creates a missing destination folder and refuses an existing file.
    /// <paramref name="smallMaster"/> adds the removable ESL header flag.</summary>
    Task CreateAndWriteAsync(ModKey modKey, string destinationPath, GameRelease gameRelease, bool smallMaster);

    /// <summary>Bytes at <paramref name="destinationPath"/>, with neither backup nor rename — what
    /// <see cref="PluginWriter"/> adds to replace a plugin in place. Null takes Mutagen's
    /// own master order (ADR-0008) and strings folder.</summary>
    Task WriteAsync(
        IMod plugin,
        string destinationPath,
        IReadOnlyList<string>? masterOrder = null,
        string? stringsFolder = null);
}
