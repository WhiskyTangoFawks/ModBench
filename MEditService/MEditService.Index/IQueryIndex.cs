using MEditService.LoadOrder;
using MEditService.Ports;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>ADR-0014 invariant 3: the Index as Queries sees it — its reads, plus the filter and
/// rebuild (target-architecture.d2 medit_core.queries). Every member has a caller in
/// <c>MEditService.Queries</c>.</summary>
public interface IQueryIndex
{
    /// <summary>Where the projection is and what it has established so far (ADR-0013): anything
    /// derived from the whole plugin set gates on this. Never null — no load order is a state.
    /// </summary>
    LoadOrderStatus Status { get; }

    /// <summary>The record filter in force and the source its SQL came from, or null. The Index
    /// holds it because the rows it prunes are the Index's.</summary>
    (string Sql, string Source)? ActiveFilter { get; }

    /// <summary>ADR-0015 invariant 3: how far the projection has landed. 0 with no store held.
    /// </summary>
    long Sequence { get; }

    /// <summary>True once <see cref="Sequence"/> reaches <paramref name="atLeast"/>; false, never a
    /// throw, when <paramref name="timeout"/> elapses first.</summary>
    Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout);

    /// <summary>Throws <see cref="NoLoadOrderException"/>, never null: with no load order held the
    /// Index has no store to read.</summary>
    IRecordReads RequireReads();

    bool Registers(PluginAddress key);

    void SetFilter(string sql, string source);

    void ClearFilter();

    /// <summary>ADR-0015 invariant 4: compares by content hash and repairs what differs, for one
    /// plugin or, when null, every registered one.</summary>
    IReadOnlyList<ValidationReport> ValidateIndex(PluginAddress? plugin);

    Task RebuildStore(GameRelease gameRelease, string instanceRoot);
}
