using DuckDB.NET.Data;
using DuckDB.NET.Native;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex.Queries;

/// <summary>Builds the answers the Index's face gives. Inside the Index a read that finds nothing held,
/// not ready or out of memory throws; here it becomes the answer.</summary>
internal sealed class IndexAnswer(Action onInvalidation)
{
    public Answer<T, IndexRefused> Of<T>(Func<T> read) => Flat<T>(() => read());

    public Answer<T, IndexRefused> Flat<T>(Func<Answer<T, IndexRefused>> read)
    {
        try
        {
            return read();
        }
        catch (Exception ex) when (RefusalOf(ex) is { } refused)
        {
            if (Store.IsInvalidation(ex)) onInvalidation();
            return refused;
        }
    }

    public Answer<T, IndexRefused> Sourced<T>(Func<Answer<T, SourceFailure>> read) =>
        Flat<T>(() =>
        {
            if (read().Holds(out var value, out var failure)) return value;
            return new IndexRefused(IndexRefusal.SourceStopped, failure.Reason);
        });

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
        DuckDBException when Store.IsInvalidation(ex) => new IndexRefused(
            IndexRefusal.IndexNotReady, $"mEdit's record index was invalidated by a fatal error: {FirstLine(ex)}"),
        // DuckDB's message goes on to advise tuning it, which is mEdit's to do and not the user's.
        DuckDBException { ErrorType: DuckDBErrorType.OutOfMemory } => new IndexRefused(
            IndexRefusal.OutOfMemory, $"mEdit's record index ran out of memory for this read: {FirstLine(ex)}"),
        _ => null,
    };
}
