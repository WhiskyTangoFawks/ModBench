using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.Ports;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>The Indexer as the query services see it: the reads, the status, the sequence and the
/// filter, plus setting and clearing the filter and the rebuild.</summary>
internal interface IQueryIndex
{
    /// <summary>Where the projection is and what it has established so far (ADR-0013): anything
    /// derived from the whole plugin set gates on this. Never null — no load order is a state.
    /// </summary>
    LoadOrderStatus Status { get; }

    /// <summary>The record filter in force and the source its SQL came from, or null. The Index
    /// holds it because the rows it prunes are the Index's.</summary>
    (string Sql, string Source)? ActiveFilter { get; }

    /// <summary>ADR-0015: how far the projection has landed. 0 with no store held.
    /// </summary>
    long Sequence { get; }

    /// <summary>True once <see cref="Sequence"/> reaches <paramref name="atLeast"/>; false, never a
    /// throw, when <paramref name="timeout"/> elapses first.</summary>
    Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout);

    /// <summary>The reads that are correct for the plugins already indexed. Throws
    /// <see cref="NoLoadOrderException"/>, never null: with no load order held the Index has no
    /// store to read.</summary>
    IRecordReads RequireReads();

    /// <summary>The reads for a query derived from the whole plugin set. Throws
    /// <see cref="IndexNotReadyException"/> until the Status is Ready: a partial set answers wrong,
    /// not smaller.</summary>
    IRecordReads RequireWholeSetReads();

    /// <summary>The source files each plugin's last failed read stopped at, while it fails. Empty with
    /// no load order held.</summary>
    IReadOnlyList<SourceFileFailure> SourceFileFailures { get; }

    /// <summary>What stopped the plugin's source tree in its last failed read, while it fails.</summary>
    UnreadableSource? WhyTreeStopped(PluginAddress key);

    /// <summary>The files that stopped the plugin's last read while the rows of the last good one
    /// stand (common.md, States, story 6).</summary>
    IReadOnlyList<SourceFileFailure>? LaterReadFailure(PluginAddress key);

    void SetFilter(string sql, string source);

    void ClearFilter();

    StoreRebuildRefused? RebuildStore(GameRelease gameRelease, string instanceRoot);
}
