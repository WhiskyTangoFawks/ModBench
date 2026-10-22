using DuckDB.NET.Data;

namespace MEditService.RecordIndex.Store;

internal sealed class StoreTransaction(DuckDBTransaction transaction) : IDisposable
{
    public void Commit() => StoreFaults.Translating(transaction.Commit);

    public void Dispose() => StoreFaults.Translating(transaction.Dispose);
}
