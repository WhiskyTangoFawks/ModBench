namespace MEditService.SourceAdapter.Tests.TestSupport;

internal static class TransactionRollback
{
    /// <summary>Puts every recorded act back, as a failed gesture would, and answers the paths left standing.</summary>
    internal static IReadOnlyList<UnrestoredPath> Undo(this SourceTransaction transaction, SourceRepository repository) =>
        transaction.Rollback(new InvalidOperationException("the batch failed"), repository).Unrestored;
}
