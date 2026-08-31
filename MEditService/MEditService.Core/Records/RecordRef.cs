namespace MEditService.Core.Records;

/// <summary>
/// Which state of a record's text a read answers from — <see cref="Effective"/> is the record's
/// current bytes, <see cref="Head"/> is the last committed state, and the two diverge for any
/// record a working-tree edit has touched (<see cref="Source.SourceRef"/> is the
/// <c>records.ref</c> column-value counterpart this maps onto). <see cref="IRecordIndex.At"/>
/// repositions a read between them.
/// </summary>
public enum RecordRef
{
    /// <summary>The default surface every <see cref="IRecordIndex"/> member (other than
    /// <see cref="IRecordIndex.At"/> itself) answers from: the record's current bytes — a
    /// working-tree edit where one exists, the committed baseline otherwise — narrowed by
    /// <see cref="IRecordIndex.SetFilter"/> when a filter is active.</summary>
    Effective,

    /// <summary>The last committed state, ignoring any working-tree edit: the committed
    /// baseline for a record that has diverged, and the same bytes as <see cref="Effective"/> for
    /// one that never has.</summary>
    Head,
}

/// <summary>
/// The reserved values for the <c>winners.record_ref</c> column (ADR-0001) — which
/// ref's stack a winner row is the answer for.
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
