using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Session;

public interface IGameSession : IDisposable
{
    string DataFolderPath { get; }
    GameRelease GameRelease { get; }
    IReadOnlyList<PluginMetadata> Plugins { get; }
    IReadOnlyList<PluginLoadFailure> LoadFailures { get; }
    string? FilterSql { get; set; }
    // #34 / ADR-0036: origin is required, not optional — a session can hold two copies of one
    // filename, so the filename alone no longer identifies which mod to return.
    IModGetter? GetMod(string pluginName, string origin);
    PluginMetadata AddPlugin(string filePath);
    PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex);
}
