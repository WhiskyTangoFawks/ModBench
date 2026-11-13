using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex.Queries;

/// <summary>Builds the answers the Index's face gives. Inside the Index a read that finds nothing held,
/// not ready or out of memory throws; here it becomes the answer.</summary>
internal sealed class IndexAnswer(Action onInvalidation, Func<CancellationToken, Task> sourceWritesRead)
{
    public Answer<T, IndexRefused> Of<T>(Func<T> read) => Flat<T>(() => read());

    /// <summary>The answer once the record index has read every source write mEdit made before it, as each overload
    /// given a token builds it.</summary>
    public Task<Answer<T, IndexRefused>> Of<T>(Func<T> read, CancellationToken cancel) => AfterSourceWrites(() => Of(read), cancel);

    public Answer<T, IndexRefused> Flat<T>(Func<Answer<T, IndexRefused>> read)
    {
        try
        {
            return read();
        }
        catch (Exception ex) when (RefusalOf(ex) is { } refused)
        {
            if (ex is IndexFaultException { Fault: IndexFault.Invalidated }) onInvalidation();
            return refused;
        }
    }

    public Task<Answer<T, IndexRefused>> Flat<T>(Func<Answer<T, IndexRefused>> read, CancellationToken cancel) =>
        AfterSourceWrites(() => Flat(read), cancel);

    public Answer<T, IndexRefused> Sourced<T>(Func<Answer<T, SourceFailure>> read) =>
        Flat<T>(() =>
        {
            if (read().Holds(out var value, out var failure)) return value;
            return new IndexRefused(IndexRefusal.SourceStopped, failure.Reason);
        });

    public Task<Answer<T, IndexRefused>> Sourced<T>(Func<Answer<T, SourceFailure>> read, CancellationToken cancel) =>
        AfterSourceWrites(() => Sourced(read), cancel);

    private async Task<Answer<T, IndexRefused>> AfterSourceWrites<T>(Func<Answer<T, IndexRefused>> answer, CancellationToken cancel)
    {
        try
        {
            await sourceWritesRead(cancel).ConfigureAwait(false);
        }
        catch (Exception ex) when (RefusalOf(ex) is { } refused)
        {
            return refused;
        }
        return answer();
    }

    public IndexRefused? Refusing(Func<IndexRefused?> act) =>
        Flat<bool>(() =>
        {
            if (act() is { } refused) return refused;
            return true;
        }).Holds(out _, out var unwound) ? null : unwound;

    private static string FirstLine(Exception ex) => ex.Message.Split('\n')[0];

    private static IndexRefused? RefusalOf(Exception ex) => ex switch
    {
        NoLoadOrderException => new IndexRefused(IndexRefusal.NoLoadOrder, ex.Message),
        IndexNotReadyException => new IndexRefused(IndexRefusal.IndexNotReady, ex.Message),
        IndexFaultException { Fault: IndexFault.Invalidated } => new IndexRefused(
            IndexRefusal.IndexNotReady, $"mEdit's record index was invalidated by a fatal error: {FirstLine(ex)}"),
        // The engine's message goes on to advise tuning it, which is mEdit's to do and not the user's.
        IndexFaultException { Fault: IndexFault.OutOfMemory } => new IndexRefused(
            IndexRefusal.OutOfMemory, $"mEdit's record index ran out of memory for this read: {FirstLine(ex)}"),
        _ => null,
    };
}
