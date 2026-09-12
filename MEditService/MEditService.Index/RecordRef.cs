namespace MEditService.Index;

/// <summary>Which state of a record's text a read answers from; the two diverge for any record a
/// working-tree edit has touched. <see cref="IRecordIndex.At"/> repositions a read between them.</summary>
internal enum RecordRef
{
    /// <summary>The record's current bytes — a working-tree edit where one exists, the committed
    /// baseline otherwise — narrowed by the active filter. The default surface every index read
    /// answers from.</summary>
    Effective,

    /// <summary>The last committed state, ignoring any working-tree edit: the committed
    /// baseline for a record that has diverged, and the same bytes as <see cref="Effective"/> for
    /// one that never has.</summary>
    Head,
}

/// <summary>The reserved <c>winners.record_ref</c> values (ADR-0009). Spelled out rather than
/// <c>RecordRef.ToString()</c> because they are written into the database and the view SQL, so a
/// renamed enum member must not change them.</summary>
internal static class WinnerRef
{
    public static string Of(RecordRef @ref) => @ref switch
    {
        RecordRef.Effective => "effective",
        RecordRef.Head => "head",
        _ => throw new ArgumentOutOfRangeException(nameof(@ref), @ref, "No winners-table value for this ref."),
    };
}
