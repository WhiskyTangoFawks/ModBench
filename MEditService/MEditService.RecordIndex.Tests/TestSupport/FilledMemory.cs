using DuckDB.NET.Data;
using DuckDB.NET.Native;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>The open Index's DuckDB memory, filled by a temporary table that cannot spill. The constructor throws
/// when one more row is not refused as out of memory. Disposing releases the memory.</summary>
internal sealed class FilledMemory : IDisposable
{
    private const int MostRowsAtOnce = 20000;
    private const int ProbesBound = 10;

    private readonly DuckDBConnection _held;

    internal FilledMemory(string indexFile)
    {
        _held = new DuckDBConnection($"DataSource={indexFile}");
        _held.Open();
        Run("SET GLOBAL temp_directory = ''; SET GLOBAL memory_limit = '2MB'; CREATE TEMPORARY TABLE held (n BIGINT)");
        for (var rows = MostRowsAtOnce; rows > 0;)
        {
            if (RanOutOfMemory(() => Run($"INSERT INTO held SELECT random()::BIGINT FROM range({rows})"))) rows /= 2;
        }
        for (var probe = 0; probe < ProbesBound; probe++)
        {
            if (RanOutOfMemory(() => Run("INSERT INTO held VALUES (0)"))) return;
        }
        throw new InvalidOperationException("Expected the filled memory to refuse one more row as out of memory.");
    }

    private void Run(string sql)
    {
        using var cmd = _held.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static bool RanOutOfMemory(Action act)
    {
        try
        {
            act();
            return false;
        }
        catch (DuckDBException ex) when (ex.ErrorType == DuckDBErrorType.OutOfMemory || ex.Message.Contains("could not allocate", StringComparison.Ordinal))
        {
            return true;
        }
    }

    public void Dispose() => _held.Dispose();
}
