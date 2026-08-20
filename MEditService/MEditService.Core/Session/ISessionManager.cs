using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Core.Session;

public interface ISessionManager
{
    IGameSession? Session { get; }
    IRecordReads? Repository { get; }

    /// <summary>
    /// The same object <see cref="Repository"/> exposes, under the wider seam — for the one caller
    /// that <i>writes</i> to the read model rather than reading it (#415's edit path, folding a
    /// working-tree change in through <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>). A separate
    /// property rather than a widening of <see cref="Repository"/>, so every read-side consumer keeps
    /// being handed a surface with no ingest or mutation verbs on it at all — which is the whole
    /// point of that narrowing.
    /// </summary>
    IRecordIndex? Index { get; }

    /// <summary>
    /// Where the load is and what it has established so far (#274 / ADR-0035). A session is readable
    /// while it is still loading, so a caller needs a way to ask what is safe to conclude from what
    /// it reads — above all, whether the winner sweep has run. Never null: no session is a state
    /// (<see cref="SessionState.None"/>), not an error.
    /// </summary>
    SessionStatus Status { get; }

    void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease);

    /// <summary>
    /// Builds the single active session from an ordered list of scattered physical plugin paths
    /// (an MO2-style instance's plugins.txt lines, enabled and disabled alike), with the game's
    /// implicit masters resolved from <paramref name="gameDirectory"/>, then indexes it and
    /// computes winners. Replaces any prior session (ADR-0015). Each plugin also carries the
    /// origin Mod Management resolved it from — a mod folder name, or a reserved PluginOrigin
    /// value (#269 / ADR-0036) — and whether it participates in winner computation, i.e. its
    /// plugins.txt `*` prefix (#270 / ADR-0035).
    /// </summary>
    void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease);

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
    /// Opens and indexes a plugin file the effective load order does not name — a copy shadowed by
    /// a higher-priority mod, or a file plugins.txt never lists — on demand, mid-session
    /// (#34 / ADR-0035). It is read-only and non-participating, so it can arrive at any time
    /// without disturbing winners or any conflict classification already on screen.
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="System.IO.FileNotFoundException"/> if the file does not exist.
    /// </summary>
    PluginResponse LoadUnlistedPlugin(string path, string origin);

    /// <summary>
    /// Closes and unindexes a plugin loaded via <see cref="LoadUnlistedPlugin"/>, leaving no row,
    /// column or record behind — ADR-0035's "hidden means absent" (#34).
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="KeyNotFoundException"/> if no such copy is loaded, including when the
    /// named copy is a load-order member: those are never unloadable, since dropping one would
    /// change winners underneath a loaded session.
    /// </summary>
    void UnloadUnlistedPlugin(string plugin, string origin);


    /// <summary>
    /// Re-reads <paramref name="plugin"/> from a <em>different</em> physical copy — the one a
    /// mod-level change has made its name resolve to — and re-indexes only that plugin, then
    /// recomputes winners so conflict state describes the new file (#279 / ADR-0035 § Live
    /// mutation). The caller supplies <paramref name="newPath"/> and <paramref name="newOrigin"/>
    /// for the same reason <see cref="LoadUnlistedPlugin"/> does: resolving a filename to a mod
    /// folder is Mod Management's job, and this side never learns how.
    /// <para>
    /// Never called on the system's own initiative: a mod-level change flags the row and stops
    /// there; this runs only at the user's explicit request.
    /// </para>
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="SessionBusyException"/> if a session load is in flight.
    /// Throws <see cref="KeyNotFoundException"/> if the load order does not name the plugin.
    /// Throws <see cref="System.IO.FileNotFoundException"/> if the new file does not exist.
    /// </summary>
    PluginResponse RereadPlugin(string plugin, string newPath, string newOrigin);

    /// <summary>
    /// Re-reads <paramref name="plugin"/> from disk and re-indexes it into the record repository,
    /// then recomputes winners. Call after committing a prepared save to disk.
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="KeyNotFoundException"/> if the plugin is not found in the current session.
    /// </summary>
    Task ReindexPlugin(string plugin);

    /// <summary>
    /// Re-reads each plugin in <paramref name="plugins"/> from disk and re-indexes them, then
    /// recomputes winners once after all plugins are indexed. Prefer over multiple
    /// <see cref="ReindexPlugin"/> calls when re-indexing more than one plugin at a time.
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="KeyNotFoundException"/> if any plugin is not found in the current session.
    /// </summary>
    Task ReindexPlugins(IReadOnlyList<string> plugins);

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
