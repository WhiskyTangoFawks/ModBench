using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Index.Queries;

/// <summary>Builds the answers the Index's face gives. Inside the Index a read that finds nothing held
/// or not ready throws; here it becomes the answer.</summary>
internal static class IndexAnswer
{
    public static Answer<T, IndexRefused> Of<T>(Func<T> read)
    {
        try
        {
            return read();
        }
        catch (Exception ex) when (RefusalOf(ex) is { } refused)
        {
            return refused;
        }
    }

    public static Answer<T, IndexRefused> Flat<T>(Func<Answer<T, IndexRefused>> read)
    {
        try
        {
            return read();
        }
        catch (Exception ex) when (RefusalOf(ex) is { } refused)
        {
            return refused;
        }
    }

    public static Answer<T, IndexRefused> Sourced<T>(Func<Answer<T, SourceFailure>> read) =>
        Flat<T>(() =>
        {
            if (read().Holds(out var value, out var failure)) return value;
            return new SourceStopped(failure);
        });

    public static IndexRefused? Refusing(Func<IndexRefused?> act)
    {
        try
        {
            return act();
        }
        catch (Exception ex) when (RefusalOf(ex) is { } refused)
        {
            return refused;
        }
    }

    private static IndexRefused? RefusalOf(Exception ex) => ex switch
    {
        NoLoadOrderException => new IndexRefused(IndexRefusal.NoLoadOrder, ex.Message),
        IndexNotReadyException => new IndexRefused(IndexRefusal.IndexNotReady, ex.Message),
        _ => null,
    };
}
