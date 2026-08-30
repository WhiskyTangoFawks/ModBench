namespace MEditService.Core.Records;

/// <summary>
/// Which state of a record's text a read answers from. Maps onto the single
/// <see cref="Source.SourceRef.Committed"/> value the <c>records.ref</c> column carries today
/// (ADR-0041) — <see cref="Head"/> answers identically to <see cref="Effective"/> until #415 gives
/// the working tree its own divergent state.
/// </summary>
public enum RecordRef
{
    /// <summary>The default surface every <see cref="IRecordIndex"/> member (other than
    /// <see cref="IRecordIndex.At"/> itself) answers from: the committed baseline, narrowed by
    /// <see cref="IRecordIndex.SetFilter"/> when a filter is active.</summary>
    Effective,

    /// <summary>The last committed state, ignoring any working-tree edit (#415). Ships in #421
    /// answering identically to <see cref="Effective"/> — the git-ref case is a later, additive
    /// addition, not built here.</summary>
    Head,
}

/// <summary>
/// The reserved values for the <c>raw.winners.record_ref</c> column (#584 / ADR-0001) — which ref's
/// stack a winner row is the answer for.
///
/// <para>Spelled out rather than taken from <c>RecordRef.ToString()</c> for the same reason
/// <see cref="Source.SourceRef"/> exists beside the <c>records."ref"</c> column it fills: these
/// strings are written into the database and into the SQL the views are built from, so renaming an
/// enum member must not silently change them. The mapping is exhaustive, so adding a third ref is a
/// compile-time decision about what it is called on disk rather than a value that appears by
/// itself.</para>
/// </summary>
internal static class WinnerRef
{
    internal static string Of(RecordRef @ref) => @ref switch
    {
        RecordRef.Effective => "effective",
        RecordRef.Head => "head",
        _ => throw new ArgumentOutOfRangeException(nameof(@ref), @ref, "No winners-table value for this ref."),
    };
}
