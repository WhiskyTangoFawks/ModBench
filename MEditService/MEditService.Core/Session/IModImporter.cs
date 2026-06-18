using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

public interface ILoadedMod : IDisposable
{
    IModGetter Getter { get; }
}

public interface IModImporter
{
    ILoadedMod Import(ModPath modPath, GameRelease gameRelease);
}
