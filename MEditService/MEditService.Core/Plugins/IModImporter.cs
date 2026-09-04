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
    /// <summary>Optional only for callers with nothing localization-specific to say; every real
    /// deep parse builds one through
    /// <see cref="Source.LocalizedStrings.ForRead(string?, string)"/>.</summary>
    ILoadedMod Import(ModPath modPath, GameRelease gameRelease, BinaryReadParameters? param = null);
}
