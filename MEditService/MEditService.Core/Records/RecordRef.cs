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
