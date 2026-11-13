using DuckDB.NET.Data;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>The open Index's DuckDB memory, filled by a temporary table that cannot spill until the next allocation
/// of any read runs out of memory. Disposing it releases the memory.</summary>
internal sealed class FilledMemory : IDisposable
{
    private readonly DuckDBConnection _held;

    internal FilledMemory(string indexFile)
    {
        _held = new DuckDBConnection($"DataSource={indexFile}");
        _held.Open();
        using var cmd = _held.CreateCommand();
        cmd.CommandText = "SET GLOBAL temp_directory = ''; SET GLOBAL memory_limit = '2MB'; CREATE TEMPORARY TABLE held (n BIGINT)";
        cmd.ExecuteNonQuery();
        cmd.CommandText = "INSERT INTO held SELECT random()::BIGINT FROM range(20000)";
        while (Inserted(cmd))
        {
        }
    }

    private static bool Inserted(DuckDBCommand insert)
    {
        try
        {
            insert.ExecuteNonQuery();
            return true;
        }
        catch (DuckDBException)
        {
            return false;
        }
    }

    public void Dispose() => _held.Dispose();
}
