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

    /// <summary>Which truth it reads is the plugin's: an untracked copy from its binary, a tracked
    /// copy from its source tree (ADR-0041), because reading a tracked copy's binary would discard
    /// uncommitted edits.</summary>
    Task ReindexPlugin(PluginKey key);

    /// <summary>Names the truth it reads rather than inferring it, for a caller that has just moved
    /// the source under a live load order. An unreadable tree is recorded and rethrown, never
    /// degraded to the binary.</summary>
    void ReingestPluginFromSource(PluginKey key);

    /// <summary>The file is gone from disk, so its rows go with it. A no-op with no load order,
    /// deliberately: the caller is a file-system watcher, where racing a teardown is ordinary rather
    /// than a mistake.</summary>
    void UnindexPlugin(PluginKey key);

    /// <summary>Throws <see cref="ArgumentException"/> if the SQL does not return a form_key
    /// column.</summary>
    void SetFilter(string sql);

    void ClearFilter();

    /// <summary>Every mutation must call this or _filter stays a snapshot of a matching set that has
    /// moved. Never throws, no-ops without a filter: a read must never throw (SourceFreshness), and
    /// the write this follows already succeeded.</summary>
    void ReapplyFilter();
}
