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

    /// <summary>
    /// Builds the single active session from an ordered list of scattered physical plugin paths
    /// (an MO2-style instance's plugins.txt lines, enabled and disabled alike), with the game's
    /// implicit masters resolved from <paramref name="gameDirectory"/>, then indexes it and
    /// computes winners. Replaces any prior session (ADR-0015). Each plugin also carries the
    /// origin Mod Management resolved it from — a mod folder name, or a reserved PluginOrigin
    /// value (#269 / ADR-0036) — and whether it participates in winner computation, i.e. its
    /// plugins.txt `*` prefix (#270 / ADR-0035).
    /// <para>
    /// The only load there is (#592). Modbench manages an MO2-style instance and nothing else, so
    /// there is no plain-Data-folder load path to be the alternative — and no honest one either: a
    /// session built by reading a <c>plugins.txt</c> beside the game's own <c>Data</c> could name no
    /// mod folders, which is what <see cref="IGameSession.InstanceRoot"/> and every
    /// <c>(plugin, origin)</c> key are built out of.
    /// </para>
    /// <para>
    /// #592 / ADR-0001: <paramref name="instanceRoot"/> is the MO2 instance root, and it is what the
    /// index file is keyed on — see <see cref="IGameSession.InstanceRoot"/>. Null asks for an
    /// in-memory index that dies with the session, which is what the test suite's fixtures want.
    /// </para>
    /// </summary>
    void LoadExplicit(
        string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease,
        string? instanceRoot = null);

    void Unload();

    /// <summary>
    /// #288 / ADR-0041: creates a new empty plugin file at <paramref name="path"/>/<paramref
    /// name="name"/>, opens it into the live session as a genuine load-order participant under
    /// <paramref name="origin"/>, and indexes it. Returns the <see cref="PluginResponse"/> for the
    /// newly created plugin. Never touches <c>plugins.txt</c> — appending the load-order line is
    /// the caller's job (Mod Management's own writer, or a script/agent's own per ADR-0024).
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="ArgumentException"/> if the name has an invalid extension, or the name,
    /// path, or origin is empty.
    /// Throws <see cref="System.IO.IOException"/> if the file already exists.
    /// </summary>
    PluginResponse CreatePlugin(string name, string path, string origin);

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
    /// Flips <paramref name="plugin"/>'s participation flag (the <c>plugins.txt</c> <c>*</c> prefix)
    /// in the running session and recomputes winners — #97 / ADR-0035 § Live mutation's checkbox
    /// gesture. SQL-only: no re-read, no re-index, and the DuckDB connection never changes, which is
    /// what makes this safe to apply live and unprompted.
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="SessionBusyException"/> if a session load is in flight.
    /// Throws <see cref="KeyNotFoundException"/> if the load order does not name the plugin.
    /// </summary>
    PluginResponse SetPluginParticipation(string plugin, bool participates);

    /// <summary>
    /// Re-reads <paramref name="plugin"/> from disk and re-indexes it into the record repository,
    /// then recomputes winners. Call after committing a prepared save to disk.
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="KeyNotFoundException"/> if the plugin is not found in the current session.
    /// </summary>
    Task ReindexPlugin(string plugin);

    /// <summary>
    /// #587 / ADR-0001: re-reads exactly the copy <paramref name="key"/> names and re-indexes it,
    /// then recomputes winners — the runtime mirror's answer to an indexed binary whose bytes moved
    /// under a live session (MO2, xEdit, Steam, or the user).
    ///
    /// <para>Keyed by <see cref="PluginKey"/> rather than by filename, unlike
    /// <see cref="ReindexPlugin(string)"/>: that overload resolves among load-order members because
    /// it answers "which file does a write land on", and this one already knows which physical copy
    /// changed — including an unlisted one, which the filename overload deliberately cannot reach.</para>
    /// Throws <see cref="InvalidOperationException"/> if no session is loaded.
    /// Throws <see cref="KeyNotFoundException"/> if the session holds no such copy.
    /// </summary>
    Task ReindexPlugin(PluginKey key);

    /// <summary>
    /// #587 / ADR-0001: <paramref name="key"/>'s file is gone from disk, so its rows go with it
    /// (<see cref="IRecordIndex.Unindex"/>, the file-gone verb) and winners are re-swept. The index
    /// holds exactly what exists.
    ///
    /// <para>A no-op with no session, deliberately: this is called from a file-system watcher, where
    /// racing a teardown is the ordinary case and not a caller mistake. It leaves the plugin in
    /// <see cref="IGameSession.Plugins"/> — <c>plugins.txt</c> still lists it and Mod Management owns
    /// that file (CONTEXT-MAP.md); what the ticket asks for, and what this gives, is that the copy
    /// stops answering reads.</para>
    /// </summary>
    void UnindexPlugin(PluginKey key);

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

    /// <summary>
    /// #422: re-materializes <c>_filter</c> from the session's own <c>FilterSql</c> — every mutation
    /// path that can change which records match (a re-index, a working-tree edit, a create, a
    /// renumber, a read-time source self-heal) must call this afterward, or the table
    /// <see cref="SetFilter"/> built stays a snapshot of a matching set that no longer exists: a record
    /// that newly matches stays hidden, one that stopped matching stays listed.
    /// <para>
    /// Deliberately a silent no-op with no session or no active filter, unlike <see cref="SetFilter"/>/
    /// <see cref="ClearFilter"/>'s throw — every caller is a mutation (or a read-time self-heal) where
    /// "no filter is active" is the ordinary case, not a caller mistake, and a throwing dependency here
    /// would make every one of those call sites carry its own guard clause, or worse would turn
    /// <c>Source.SourceFreshness</c>'s "a read must never throw" posture into a lie.
    /// </para>
    /// <para>
    /// <b>Never throws.</b> A re-materialization fault (the filter SQL itself faulting against the
    /// index's new state) is logged as a warning naming the exception and degrades to serving the
    /// stale <c>_filter</c> table rather than propagating — by the time this runs on every mutation
    /// call site, the write it followed (a source file, a binary re-index) is already durable, so
    /// letting the fault escape here would 500 a gesture that actually succeeded. Same posture as the
    /// no-op branch above, extended to a failure that only surfaces once the filter is re-run, not at
    /// <see cref="SetFilter"/>'s own validation time.
    /// </para>
    /// </summary>
    void ReapplyFilter();
}
