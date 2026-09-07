using MEditService.Core.Queries;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Core.Plugins;

/// <summary>Editing's two mirrors (ADR-0044): which plugin copies are held with their
/// registrations, and the index over their files. Kept true by reconcile and by observation;
/// nothing is loaded, reloaded or exited.</summary>
public interface ILoadOrderMirror
{
    ILoadOrder? LoadOrder { get; }
    IRecordReads? Reads { get; }

    /// <summary>A separate property rather than a widening of <see cref="Reads"/>: read-side
    /// consumers keep being handed a surface with no ingest or mutation verbs on it at all.</summary>
    IRecordIndex? Index { get; }

    /// <summary>On the mirror because it owns the index: a separate registration could hand out a
    /// gate that guards nothing. The mirror's write doors take it for their callers; a caller
    /// writing through Index takes it itself.</summary>
    IndexWriteGate WriteGate { get; }

    /// <summary>Where the reconcile is and what it has established so far (ADR-0035): the load
    /// order is readable while it is still being reconciled. Never null — no load order is a state,
    /// not an error.</summary>
    LoadOrderStatus Status { get; }

    /// <summary>ADR-0046: the Index's projection sequence, or 0 with no index held. Read-your-writes
    /// belongs here: a caller re-reads once this is past the sequence its write returned.</summary>
    long Sequence { get; }

    /// <summary>ADR-0046: everything projected inside the scope advances <see cref="Sequence"/> once,
    /// when the outermost scope closes. A no-op scope with no index held.</summary>
    IDisposable BeginProjection();

    /// <summary>Runs <paramref name="publish"/> once the projection it was raised in has landed, so
    /// nothing names a sequence the store has not reached. Runs at once with no index held.</summary>
    void Announce(Action publish);

    /// <summary>Polls <see cref="Sequence"/> until it reaches <paramref name="atLeast"/> or
    /// <paramref name="timeout"/> elapses. True the moment it lands; false, never a throw, on a
    /// timeout — the answer is "not yet", not a failure.</summary>
    Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout);

    /// <summary>Throws <see cref="NoLoadOrderException"/>, never null: the load order and the index
    /// are only ever both set or both null, so this can never observe one without the other.</summary>
    (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope();

    /// <summary>ADR-0044's one verb. A snapshot identical to what is held is a no-op; a reconcile
    /// superseded by another throws <see cref="OperationCanceledException"/>, leaving its work for
    /// its successor.</summary>
    void Reconcile(
        string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease,
        string? instanceRoot = null);

    /// <summary>Drops everything held: the load order and the index connection. Cancels an
    /// in-flight reconcile and waits for it to stop first.</summary>
    void Close();

    /// <summary>ADR-0041: the new plugin is a genuine load-order participant at once. Nothing here
    /// touches plugins.txt — appending the line is the caller's job, and the snapshot that follows
    /// corrects the slot.</summary>
    PluginResponse CreatePlugin(string name, string path, string origin);

    /// <summary>ADR-0046 invariant 6's reconcile request: validates <paramref name="plugin"/>, or
    /// every registered copy when null, and repairs what differs. <c>NeedsRebuild</c> names a copy
    /// this call re-derived whole.</summary>
    IReadOnlyList<ValidationReport> ValidateIndex(PluginKey? plugin);

    /// <summary>ADR-0046 invariant 4's narrow signal: re-projects these keys from the source tree under
    /// the write gate. An untracked or unheld copy is a no-op.</summary>
    void RefreshKeys(PluginKey key, IReadOnlyList<string> formKeys);

    /// <summary>Raised once a reconcile settles and once <see cref="Close"/> empties the mirror, so the
    /// composition root re-registers the Source watches. Core names no watcher type.</summary>
    Action? LoadOrderChanged { get; set; }

    /// <summary>Which truth it reads is the plugin's: an untracked copy from its binary, a tracked
    /// copy from its source tree (ADR-0041), because reading a tracked copy's binary would discard
    /// uncommitted edits.</summary>
    Task ReindexPlugin(PluginKey key);

    /// <summary>The file is gone, so its rows go with it. A no-op while the held copy still exists
    /// or with no load order: the watcher that calls this races teardowns and superseding load
    /// orders.</summary>
    void UnindexPlugin(PluginKey key);

    /// <summary>Throws <see cref="ArgumentException"/> if the SQL does not return a form_key
    /// column.</summary>
    void SetFilter(string sql);

    void ClearFilter();

    /// <summary>Every mutation must call this or _filter stays a snapshot of a matching set that has
    /// moved. Never throws, no-ops without a filter: the write this follows already succeeded.</summary>
    void ReapplyFilter();
}
