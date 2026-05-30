using MEditService.Core.Queries;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Core.Session;

public interface ISessionManager
{
    IGameSession? Session { get; }
    IRecordRepository? Repository { get; }

    void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease);
    void Unload();

    /// <summary>
    /// Creates a new empty plugin file in the data folder, appends it to plugins.txt, and reloads the session.
    /// Returns the <see cref="PluginResponse"/> for the newly created plugin.
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="ArgumentException"/> if the name has an invalid extension.
    /// Throws <see cref="System.IO.IOException"/> if the file already exists.
    /// </summary>
    PluginResponse CreatePlugin(string name);
}
