namespace MEditService.SourceAdapter;

/// <summary>Source changes to one repository, or to the batch it reads through, applied all or restored all
/// (commands.md, A failed gesture writes nothing; ADR-0003).</summary>
public sealed class SourceTransaction
{
    private readonly SourceRepository _repository;
    private readonly WriteJournal _journal;
    private readonly SourceBatch? _batch;
    private readonly SourceChanges? _batchChangesBefore;
    private SourceFailure? _stopped;

    private SourceTransaction(SourceRepository repository)
    {
        _repository = repository;
        _journal = new WriteJournal(repository.ModFolder);
        _batch = repository.Files as SourceBatch;
        _batchChangesBefore = _batch?.Changes;
    }

    /// <summary>Runs <paramref name="write"/> on a new transaction. A change that failed puts back what it
    /// applied, and the answer is why.</summary>
    public static SourceFailure? Atomically(SourceRepository repository, Action<SourceTransaction> write) =>
        Atomically(repository, transaction =>
        {
            write(transaction);
            return SourceAnswer.Of(true);
        }).Holds(out _, out var failure)
            ? null
            : failure;

    /// <summary><see cref="Atomically(SourceRepository, Action{SourceTransaction})"/>, answering what
    /// <paramref name="write"/> answers. A failure it answers puts back what it applied too.</summary>
    public static SourceAnswer<T> Atomically<T>(SourceRepository repository, Func<SourceTransaction, SourceAnswer<T>> write)
    {
        var transaction = new SourceTransaction(repository);
        return SourceFailure.Answer(() => transaction.Settled(transaction.Run(write))).Then(settled => settled);
    }

    // What the transaction answers once its writes stand, or the throw that puts them back.
    private SourceAnswer<T> Settled<T>(SourceAnswer<T> answered)
    {
        if (!answered.Holds(out _, out var failure)) _stopped ??= failure;
        return _stopped is { } stopped ? throw PutBack(stopped) : answered;
    }

    private T Run<T>(Func<SourceTransaction, T> write)
    {
        try
        {
            return write(this);
        }
        catch (Exception cause) when (cause is not OutOfMemoryException)
        {
            if (_journal.Report(cause, UndoAll()) is { } report) throw report;
            throw;
        }
    }

    // The rollback's report when it left a path standing, else the stop.
    private Exception PutBack(SourceFailure stopped)
    {
        var stop = SourceStopException.Of(stopped);
        return _journal.Report(stop, UndoAll()) ?? stop;
    }

    private List<Unrestored> UndoAll()
    {
        if (_batch is not null && _batchChangesBefore is not null) _batch.Changes = _batchChangesBefore;
        var unrestored = _journal.UndoSince(0);
        _repository.Locator.Forget();
        return unrestored;
    }

    /// <summary>Makes each move of <paramref name="changes"/>, then each deletion, then writes each document, holding what each
    /// replaced. Changes that failed stop the transaction, and nothing after them applies.</summary>
    public void Apply(SourceAnswer<SourceChanges> changes)
    {
        if (_stopped is not null) return;
        if (!changes.Holds(out var made, out var failure))
        {
            _stopped = failure;
            return;
        }

        var absolute = made.Under(_repository);
        try
        {
            if (_batch is not null)
            {
                _batch.Apply(absolute);
                return;
            }
            foreach (var (from, to) in absolute.Moves) _journal.Move(from, to);
            foreach (var path in absolute.Deletions) _journal.DeletePath(path);
            foreach (var (path, text) in absolute.Documents) _journal.WriteText(path, text);
        }
        catch (Exception ex) when (SourceFailure.Of(ex) is { } stopped)
        {
            _stopped = stopped;
        }
        finally
        {
            _repository.Locator.Forget();
        }
    }
}
