using DuckDB.NET.Data;
using DuckDB.NET.Native;

namespace MEditService.RecordIndex.Store;

/// <summary>Restates what the engine throws in the record index's own exceptions, so no client type
/// leaves the Store.</summary>
internal static class StoreFaults
{
    public static Exception Of(DuckDBException ex) => ex.ErrorType switch
    {
        DuckDBErrorType.Fatal => new IndexFaultException(ex.Message, ex) { Fault = IndexFault.Invalidated },
        DuckDBErrorType.OutOfMemory => new IndexFaultException(ex.Message, ex) { Fault = IndexFault.OutOfMemory },
        _ => new IndexFaultException(ex.Message, ex) { Fault = IndexFault.BadSql },
    };

    public static T Translating<T>(Func<T> act)
    {
        try
        {
            return act();
        }
        catch (DuckDBException ex)
        {
            throw Of(ex);
        }
    }
}
