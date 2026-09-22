namespace MEditService.TestSupport.TestSupport;

public static class OwnedFixture
{
    /// <summary>Builds a disposable fixture and hands it — or whatever <paramref name="build"/>
    /// wraps it in — to the caller, undisposed only on that success path.</summary>
    public static TResult Build<TOwned, TResult>(
        Func<TOwned> create, Action<TOwned> configure, Func<TOwned, TResult> build)
        where TOwned : class, IDisposable
    {
        TOwned? owned = create();
        try
        {
            configure(owned);
            var result = build(owned);
            owned = null;
            return result;
        }
        finally
        {
            owned?.Dispose();
        }
    }
}
