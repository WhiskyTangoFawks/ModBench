namespace MEditService.SourceAdapter;

/// <summary>Source changes to one repository, applied all or restored all (commands.md,
/// A failed gesture writes nothing; ADR-0003).</summary>
public sealed class SourceTransaction
{
    private readonly SourceRepository _repository;
    private readonly WriteJournal _journal;

    private SourceTransaction(SourceRepository repository)
    {
        _repository = repository;
        _journal = new WriteJournal(repository.ModFolder);
    }

    /// <summary>Runs <paramref name="write"/> on a new transaction. A throw puts back what it applied and is
    /// rethrown, or becomes the rollback's report when that left a path standing.</summary>
    public static void Atomically(SourceRepository repository, Action<SourceTransaction> write) =>
        Atomically(repository, transaction =>
        {
            write(transaction);
            return true;
        });

    /// <summary><see cref="Atomically(SourceRepository, Action{SourceTransaction})"/>, answering what
    /// <paramref name="write"/> answers.</summary>
    public static T Atomically<T>(SourceRepository repository, Func<SourceTransaction, T> write)
    {
        var transaction = new SourceTransaction(repository);
        try
        {
            return write(transaction);
        }
        catch (Exception cause) when (cause is not OutOfMemoryException)
        {
            if (transaction._journal.Report(cause, transaction._journal.UndoSince(0)) is { } report) throw report;
            throw;
        }
    }

    /// <summary>Makes each move of <paramref name="changes"/> and then writes each document, holding what
    /// each act replaced so a later failure in this batch puts it back.</summary>
    public void Apply(SourceChanges changes)
    {
        var (moves, documents) = changes.Under(_repository);
        try
        {
            foreach (var (from, to) in moves) _journal.Move(from, to);
            foreach (var (path, text) in documents) _journal.WriteText(path, text);
        }
        finally
        {
            _repository.Locator.Forget();
        }
    }
}
