namespace MEditService.SourceAdapter.Tests.TestSupport;

internal static class TransactionRollback
{
    private sealed class BatchFailed() : Exception("the batch failed");

    /// <summary>Runs <paramref name="acts"/> in a transaction, then fails the gesture. Answers the report of
    /// what the rollback left standing, or null when it left nothing.</summary>
    internal static string? After(SourceRepository repository, Action<SourceTransaction> acts)
    {
        try
        {
            SourceTransaction.Atomically(repository, transaction =>
            {
                acts(transaction);
                throw new BatchFailed();
            });
        }
        catch (BatchFailed)
        {
            return null;
        }
        catch (AggregateException report) when (report.InnerException is BatchFailed)
        {
            return report.Message;
        }

        throw new InvalidOperationException("The transaction did not fail.");
    }
}
