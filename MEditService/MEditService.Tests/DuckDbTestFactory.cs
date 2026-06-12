using DuckDB.NET.Data;
using MEditService.Core.Edits;

namespace MEditService.Tests;

internal static class DuckDbTestFactory
{
    internal static DuckDbPendingChangeService MakePendingChangeService()
    {
        var conn = new DuckDBConnection("DataSource=:memory:");
        conn.Open();
        return new DuckDbPendingChangeService(conn);
    }
}
