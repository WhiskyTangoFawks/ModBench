using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

public sealed class DefaultModImporter : IModImporter
{
    public ILoadedMod Import(ModPath modPath, GameRelease gameRelease)
        => new LoadedMod(ModFactory.ImportGetter(modPath, gameRelease));

    private sealed class LoadedMod(IModDisposeGetter inner) : ILoadedMod
    {
        public IModGetter Getter => inner;
        public void Dispose() => inner.Dispose();
    }
}
