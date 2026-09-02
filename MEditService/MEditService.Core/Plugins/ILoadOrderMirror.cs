using MEditService.Core.Queries;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Core.Plugins;

/// <summary>
/// Editing's two mirrors (ADR-0044): the load order — which plugin copies are held and what their
/// registrations say — and the index over their files. Both are kept true by reconcile
/// (<see cref="Reconcile"/>) and by observation (the bridge watcher); nothing is loaded, reloaded
/// or exited.
/// </summary>
public interface ILoadOrderMirror
{
    ILoadOrder? LoadOrder { get; }
    IRecordReads? Reads { get; }

    /// <summary>
    /// The same object <see cref="Reads"/> exposes, under the wider seam — for the one caller
    /// that <i>writes</i> to the read model rather than reading it (the edit path, folding a
    /// working-tree change in through <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>). A separate
    /// property rather than a widening of <see cref="Reads"/>, so every read-side consumer keeps
    /// being handed a surface with no ingest or mutation verbs on it at all — which is the whole
    /// point of that narrowing.
    /// </summary>
    IRecordIndex? Index { get; }

    /// <summary>
    /// Where the reconcile is and what it has established so far (ADR-0035). The load order
    /// is readable while it is still being reconciled, so a caller needs a way to ask what is safe
    /// to conclude from what it reads — above all, whether the winner sweep has run. Never null: no
    /// load order is a state (<see cref="LoadOrderState.None"/>), not an error.
    /// </summary>
    LoadOrderStatus Status { get; }

    /// <summary>
    /// <see cref="LoadOrder"/> and <see cref="Reads"/>, non-null together — the one "no load
    /// order held" gate; consumers call this rather than null-checking those two
    /// nullable properties themselves. Throws <see cref="NoLoadOrderException"/>, never null: <c>LoadOrder</c>
    /// and the index behind <c>Reads</c>/<c>Index</c> are only ever both set or both null (a
    /// reconcile publishes them together; <see cref="Close"/> drops them together), so this can
    /// never observe one without the other.
    /// </summary>
    (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope();

    /// <summary>
    /// ADR-0044's one verb: reconciles Mod Management's snapshot — every physical plugin copy in the
    /// instance, each with its slot, <c>*</c> prefix and winning flag — against what is held. A copy
    /// new to the load order is opened and registered (indexed only if the mirror has never seen its
    /// file — ADR-0001, progressively); a held copy absent from the snapshot is unregistered;
    /// a held copy whose registration moved is re-registered, SQL-only; then one winner sweep, one
    /// filter re-materialization. A snapshot identical to what is held is a no-op — no sweep, no
    /// progress. The game's implicit masters are resolved from <paramref name="gameDirectory"/> and
    /// prepended, forced on.
    /// <para>
    /// ADR-0001: <paramref name="instanceRoot"/> is the MO2 instance root, and it is what the
    /// index file is keyed on — see <see cref="ILoadOrder.InstanceRoot"/>. Null asks for an
    /// in-memory index, which is what the test suite's fixtures want. A snapshot for a different
    /// instance, game directory or release than the one held replaces everything held.
    /// </para>
    /// <para>Blocking: returns once the sweep has run. A reconcile superseded by another (or by
    /// <see cref="Close"/>) throws <see cref="OperationCanceledException"/> and leaves whatever it
    /// had reconciled so far for its successor to finish.</para>
    /// </summary>
    void Reconcile(
        string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease,
        string? instanceRoot = null);

    /// <summary>Drops everything held: the load order and the index connection. Cancels an
    /// in-flight reconcile and waits for it to stop first.</summary>
    void Close();

    /// <summary>
    /// ADR-0041: creates a new empty plugin file at <paramref name="path"/>/<paramref
    /// name="name"/>, holds it as a genuine load-order participant under <paramref name="origin"/>,
    /// and indexes it. Returns the <see cref="PluginResponse"/> for the newly created plugin. Never
    /// touches <c>plugins.txt</c> — appending the load-order line is the caller's job (Mod
    /// Management's own writer, or a script/agent's own per ADR-0024), and the snapshot that
    /// follows corrects the slot.
    /// Throws <see cref="NoLoadOrderException"/> if no load order is held.
    /// Throws <see cref="ArgumentException"/> if the name has an invalid extension, or the name,
    /// path, or origin is empty.
    /// Throws <see cref="System.IO.IOException"/> if the file already exists.
    /// </summary>
    PluginResponse CreatePlugin(string name, string path, string origin);

    /// <summary>
    /// ADR-0001: re-derives exactly the copy <paramref name="key"/> names, then recomputes winners —
    /// the runtime mirror's answer to an indexed binary whose bytes moved under a held load order
    /// (MO2, xEdit, Steam, or the user). Keyed by <see cref="PluginKey"/> rather than by filename, so
    /// it can reach a losing copy too, not only whichever copy a bare filename would resolve to.
    ///
    /// <para><b>Which truth it reads is the plugin's, not the caller's</b> (#672). An <i>untracked</i>
    /// copy is re-read from its binary, which is its source of truth. A <i>tracked</i> copy is
    /// re-derived from its source tree instead, which is its source of truth (ADR-0041/ADR-0042) —
    /// this delegates to <see cref="ReingestPluginFromSource"/> and never opens the binary for it.
    /// Reading the binary for a tracked copy would replace source-derived rows with compiled content
    /// and silently discard the author's uncommitted edits, which is exactly what a Track followed by
    /// a Save &amp; Compile used to do: Track does not reconcile the load order, so a copy that was
    /// untracked at the last reconcile keeps its index-mirror watch, and the compile's own write fires
    /// it.</para>
    ///
    /// Throws <see cref="NoLoadOrderException"/> if no load order is held.
    /// Throws <see cref="KeyNotFoundException"/> if no such copy is held.
    /// </summary>
    Task ReindexPlugin(PluginKey key);

    /// <summary>
    /// Re-derives the tracked copy <paramref name="key"/> names from its <b>source tree</b> —
    /// its rows and its committed-versus-working-tree divergence alike — and recomputes winners. The
    /// source-truth counterpart of <see cref="ReindexPlugin"/>'s binary re-read, and a distinct
    /// operation from it: this one names the truth it reads rather than inferring it, which is what a
    /// caller that has just moved the source under a live load order (a rollback, a revert, a
    /// checkout) actually wants to say.
    ///
    /// <para><b>Does not degrade to the binary, but never fails silently either.</b> If the tree
    /// cannot be read, the index keeps serving the source-derived rows it already held — falling back
    /// to compiled content here would resurrect precisely the silent-loss failure this door exists to
    /// prevent, which is what makes this different from the reconcile-time ingest's own binary
    /// fallback (there, there are no rows yet, so the binary beats nothing). The failure is recorded
    /// in <see cref="ILoadOrder.LoadFailures"/> — the same channel <c>GET /load-order/status</c>
    /// surfaces (ADR-0026) — and then rethrown.</para>
    ///
    /// Throws <see cref="NoLoadOrderException"/> if no load order is held.
    /// Throws <see cref="KeyNotFoundException"/> if no such copy is held.
    /// Throws <see cref="InvalidOperationException"/> if that copy has no source tree — it is not
    /// tracked, so it has no source truth to re-derive from.
    /// </summary>
    void ReingestPluginFromSource(PluginKey key);

    /// <summary>
    /// ADR-0001: <paramref name="key"/>'s file is gone from disk, so its rows go with it
    /// (<see cref="IRecordIndex.Unindex"/>, the file-gone verb) and winners are re-swept. The index
    /// holds exactly what exists.
    ///
    /// <para>A no-op with no load order, deliberately: this is called from a file-system watcher,
    /// where racing a teardown is the ordinary case and not a caller mistake. It leaves the copy in
    /// <see cref="ILoadOrder.Plugins"/> — the snapshot still names it and Mod Management owns that
    /// (CONTEXT-MAP.md); what this gives is that the copy stops answering reads.</para>
    /// </summary>
    void UnindexPlugin(PluginKey key);

    /// <summary>
    /// Materializes the filter SQL into the _filter table and records the active SQL on the load order.
    /// Throws <see cref="NoLoadOrderException"/> if no load order is held.
    /// Throws <see cref="ArgumentException"/> if the SQL does not return a form_key column.
    /// </summary>
    void SetFilter(string sql);

    /// <summary>
    /// Drops the _filter table and clears the active SQL on the load order.
    /// Throws <see cref="NoLoadOrderException"/> if no load order is held.
    /// </summary>
    void ClearFilter();

    /// <summary>
    /// Re-materializes <c>_filter</c> from the load order's own <c>FilterSql</c> — every
    /// mutation path that can change which records match (a re-index, a working-tree edit, a create,
    /// a renumber, a read-time source self-heal, a reconcile) must call this afterward, or the table
    /// <see cref="SetFilter"/> built stays a snapshot of a matching set that no longer exists: a record
    /// that newly matches stays hidden, one that stopped matching stays listed.
    /// <para>
    /// Deliberately a silent no-op with no load order or no active filter, unlike <see cref="SetFilter"/>/
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
