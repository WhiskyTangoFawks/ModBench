using System.Globalization;
using DuckDB.NET.Data;

namespace MEditService.Tests.TestSupport;

/// <summary>SQL over the instance's store file. DuckDB.NET shares one database instance per path in
/// a process, so this joins the Index's own rather than contending with it.</summary>
internal static class StoreFile
{
    internal static DuckDBConnection Open(string instanceRoot)
    {
        var connection = new DuckDBConnection($"Data Source={IndexFiles.In(instanceRoot)}");
        connection.Open();
        return connection;
    }

    internal static object? Scalar(string instanceRoot, string sql, params object[] parameters)
    {
        using var connection = Open(instanceRoot);
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var p in parameters) cmd.Parameters.Add(new DuckDBParameter { Value = p });
        return cmd.ExecuteScalar();
    }

    internal static long Count(string instanceRoot, string sql, params object[] parameters) =>
        Convert.ToInt64(Scalar(instanceRoot, sql, parameters), CultureInfo.InvariantCulture);

    internal static void Execute(string instanceRoot, string sql, params object[] parameters)
    {
        using var connection = Open(instanceRoot);
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var p in parameters) cmd.Parameters.Add(new DuckDBParameter { Value = p });
        cmd.ExecuteNonQuery();
    }

    internal static List<string> Strings(string instanceRoot, string sql, params object[] parameters)
    {
        using var connection = Open(instanceRoot);
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var p in parameters) cmd.Parameters.Add(new DuckDBParameter { Value = p });
        using var reader = cmd.ExecuteReader();
        var values = new List<string>();
        while (reader.Read()) values.Add(reader.GetString(0));
        return values;
    }
}
