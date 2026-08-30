using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Plugins;

public sealed class DefaultModImporter : IModImporter
{
    public ILoadedMod Import(ModPath modPath, GameRelease gameRelease, BinaryReadParameters? param = null)
        => new LoadedMod(ModFactory.ImportGetter(modPath, gameRelease, param));

    private sealed class LoadedMod(IModDisposeGetter inner) : ILoadedMod
    {
        public IModGetter Getter => inner;
        public void Dispose() => inner.Dispose();
    }
}
