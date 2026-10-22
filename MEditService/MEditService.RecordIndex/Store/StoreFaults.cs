using DuckDB.NET.Data;
using DuckDB.NET.Native;

namespace MEditService.RecordIndex.Store;

internal static class StoreFaults
{
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

    public static void Translating(Action act) => Translating(() =>
    {
        act();
        return true;
    });

    private static IndexFaultException Of(DuckDBException ex) => new(ex.Message)
    {
        Fault = ex.ErrorType switch
        {
            DuckDBErrorType.Fatal => IndexFault.Invalidated,
            DuckDBErrorType.OutOfMemory => IndexFault.OutOfMemory,
            DuckDBErrorType.Conversion or DuckDBErrorType.OutOfRange or DuckDBErrorType.InvalidInput => IndexFault.RowValue,
            _ => IndexFault.Refused,
        },
    };
}
