using MEditService.LoadOrder;
using MEditService.Ports;

namespace MEditService.Index;

/// <summary>ADR-0014 invariant 3: the Index as its only readers see it. Every member has a caller
/// in <c>MEditService.Queries</c>, and an architecture test says so.</summary>
public interface IQueryIndex
{
    /// <summary>Where the projection is and what it has established so far (ADR-0013): anything
    /// derived from the whole plugin set gates on this. Never null — no load order is a state.
    /// </summary>
    LoadOrderStatus Status { get; }

    /// <summary>The record filter in force, or null. The Index holds it because the rows
    /// it prunes are the Index's.</summary>
    string? FilterSql { get; }

    /// <summary>Throws <see cref="NoLoadOrderException"/>, never null: with no load order held the
    /// Index has no store to read.</summary>
    IRecordReads RequireReads();
}
