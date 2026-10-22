using System.Globalization;
using DuckDB.NET.Data;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>The one store file a reconcile over an instance leaves on disk (ADR-0010), found rather
/// than computed: where the Index keeps it is the Index's own.</summary>
internal static class IndexFiles
{
    internal static string In(string instanceRoot) =>
        Directory.GetFiles(instanceRoot, "*.duckdb", SearchOption.AllDirectories).Single();

    /// <summary>Runs <paramref name="sql"/> on the open Index's own database, joining it as
    /// <see cref="Rows"/> does.</summary>
    internal static void Execute(string instanceRoot, string sql)
    {
        using var connection = new DuckDBConnection($"DataSource={In(instanceRoot)}");
        connection.Open();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    /// <summary>Holds the open Index's DuckDB to <paramref name="memoryLimit"/>, on a pinned number of
    /// threads, since DuckDB's memory grows with them.</summary>
    internal static void LimitMemory(string instanceRoot, string memoryLimit) =>
        Execute(instanceRoot, $"SET GLOBAL memory_limit = '{memoryLimit}'; SET GLOBAL threads = 4");

    /// <summary>Leaves DuckDB to abort its next checkpoint: a fatal error that invalidates the index file.</summary>
    internal static void AbortNextCheckpoint(string instanceRoot) =>
        Execute(instanceRoot, "SET GLOBAL checkpoint_threshold = '1KB'; SET GLOBAL debug_checkpoint_abort = 'before_header'");

    /// <summary>Invalidates the open Index's database: a checkpoint aborted by a fatal error.</summary>
    internal static void Invalidate(string instanceRoot)
    {
        AbortNextCheckpoint(instanceRoot);
        try
        {
            Execute(instanceRoot, "CREATE TABLE aborts_the_checkpoint AS SELECT range AS n FROM range(100000)");
        }
        catch (DuckDBException)
        {
            return;
        }
        throw new InvalidOperationException("Expected the aborted checkpoint to invalidate the database.");
    }

    /// <summary>Every row <paramref name="sql"/> yields over the public relations, sorted, as text.
    /// DuckDB.NET shares one database per path in a process, so this joins the open Index's own and
    /// leaves its filter alone.</summary>
    internal static List<string[]> Rows(string instanceRoot, string sql)
    {
        using var connection = new DuckDBConnection($"DataSource={In(instanceRoot)}");
        connection.Open();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT * FROM ({sql}) ORDER BY ALL";
        using var reader = cmd.ExecuteReader();
        var rows = new List<string[]>();
        while (reader.Read())
        {
            rows.Add([.. Enumerable.Range(0, reader.FieldCount).Select(i =>
                reader.IsDBNull(i) ? "NULL" : Convert.ToString(reader.GetValue(i), CultureInfo.InvariantCulture) ?? "")]);
        }
        return rows;
    }
}
