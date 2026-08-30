using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Plugins;

public interface ILoadedMod : IDisposable
{
    IModGetter Getter { get; }
}

public interface IModImporter
{
    /// <summary>
    /// #515: <paramref name="param"/> is optional only for callers with nothing localization-
    /// specific to say (a test double, typically) — every real deep parse should build one through
    /// <see cref="Source.LocalizedStrings.ForRead(string?, string)"/>, the same as every other
    /// deep-parse call site.
    /// </summary>
    ILoadedMod Import(ModPath modPath, GameRelease gameRelease, BinaryReadParameters? param = null);
}
