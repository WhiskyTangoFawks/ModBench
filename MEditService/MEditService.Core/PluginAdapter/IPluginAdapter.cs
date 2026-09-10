using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
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
    /// <summary>An overlay for reading. <paramref name="param"/> is optional only for callers with
    /// nothing localization-specific to say; every real deep parse builds one through
    /// <see cref="Source.LocalizedStrings.ForRead(string?, string)"/>.</summary>
    ILoadedMod OpenForRead(ModPath modPath, GameRelease gameRelease, BinaryReadParameters? param = null);

    /// <summary>A deep parse the caller may mutate, for the gestures that re-serialize or re-write a
    /// plugin. Same <paramref name="param"/> rule as <see cref="OpenForRead"/>.</summary>
    IMod OpenForWrite(ModPath modPath, GameRelease gameRelease, BinaryReadParameters? param = null);

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
