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

/// <summary>Bytes to a live Mutagen mod and back, in four verbs (ADR-0032 rule 2). The game release
/// is a parameter of every one of them, so no caller names a game to open or write a plugin.</summary>
public interface IPluginAdapter
{
    /// <summary>An overlay for reading. <paramref name="strings"/> is optional only for callers with
    /// nothing localization-specific to say: "pass nothing" is not neutral for a localized
    /// plugin.</summary>
    ILoadedMod OpenForRead(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null);

    /// <summary>The same plugin as the documents its source tree would hold (ADR-0041), for callers
    /// outside the codec/adapter pair. Owns the open until the result is disposed.</summary>
    IPluginDocuments OpenDocuments(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null);

    /// <summary>A deep parse the caller may mutate, for the gestures that re-serialize or re-write a
    /// plugin. Same <paramref name="strings"/> rule as <see cref="OpenForRead"/>.</summary>
    IMod OpenForWrite(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null);

    /// <summary>An empty mod of <paramref name="gameRelease"/>'s own type, carrying nothing but its
    /// header.</summary>
    IMod CreateEmpty(ModKey modKey, GameRelease gameRelease);

    /// <summary>Bytes at <paramref name="destinationPath"/>, with neither backup nor rename — what
    /// <see cref="PluginWriter"/> adds to replace a plugin in place (ADR-0008). Null takes Mutagen's
    /// own master order (ADR-0038) and strings folder.</summary>
    Task WriteAsync(
        IMod plugin,
        string destinationPath,
        IReadOnlyList<string>? masterOrder = null,
        string? stringsFolder = null);
}
