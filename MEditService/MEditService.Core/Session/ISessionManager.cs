using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Core.Session;

public interface ISessionManager
{
    IGameSession? Session { get; }
    IRecordReader? Repository { get; }

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

    /// <summary>
    /// Writes <paramref name="changes"/> to disk via the plugin writer, then re-indexes the updated plugin
    /// into the record repository and recomputes winners. Owns the full save lifecycle.
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="KeyNotFoundException"/> if the plugin is not found in the current session.
    /// </summary>
    Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes);

    /// <summary>
    /// Reserves and returns the next available FormKey string for <paramref name="plugin"/>,
    /// atomically incrementing the internal counter.
    /// Throws <see cref="ArgumentException"/> if the plugin has no reservation counter (not loaded or immutable).
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// </summary>
    string ReserveFormKey(string plugin);

    /// <summary>
    /// Materializes the filter SQL into the _filter table and records the active SQL on the session.
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="ArgumentException"/> if the SQL does not return a form_key column.
    /// </summary>
    void SetFilter(string sql);

    /// <summary>
    /// Drops the _filter table and clears the active SQL on the session.
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// </summary>
    void ClearFilter();
}
