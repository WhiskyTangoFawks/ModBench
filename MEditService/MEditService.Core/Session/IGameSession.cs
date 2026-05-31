using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

public interface IGameSession : IDisposable
{
    string DataFolderPath { get; }
    GameRelease GameRelease { get; }
    IReadOnlyList<PluginMetadata> Plugins { get; }
    ILinkCache LinkCache { get; }
    IModGetter? GetMod(string pluginName);
    PluginMetadata AddPlugin(string filePath);
}
