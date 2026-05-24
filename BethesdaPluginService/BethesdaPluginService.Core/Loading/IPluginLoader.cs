namespace BethesdaPluginService.Core.Loading;

public interface IPluginLoader
{
    IReadOnlyList<PluginMetadata> LoadPlugins(string dataFolderPath, string pluginsTxtPath);
}
