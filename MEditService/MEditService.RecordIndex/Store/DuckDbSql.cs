using System.Data.Common;
using DuckDB.NET.Data;

namespace MEditService.RecordIndex.Store;

/// <summary>Parameterized-command plumbing shared by two or more index collaborators; the
/// connection is an explicit first parameter. A member with exactly one consumer belongs on that
/// consumer instead.</summary>
internal static class DuckDbSql
{
    public static List<T> Rows<T>(
        DuckDBConnection connection, string sql, Func<DbDataReader, T> map, params object?[] args)
    {
        return StoreFaults.Translating(() =>
        {
            using var cmd = Command(connection, sql, args);
            using var reader = cmd.ExecuteReader();
            var rows = new List<T>();
            while (reader.Read()) rows.Add(map(reader));
            return rows;
        });
    }

    public static int Execute(DuckDBConnection connection, string sql, params object?[] args)
    {
        return StoreFaults.Translating(() =>
        {
            using var cmd = Command(connection, sql, args);
            return cmd.ExecuteNonQuery();
        });
    }

    public static string? ScalarString(DuckDBConnection connection, string sql, params object?[] args)
    {
        return StoreFaults.Translating(() =>
        {
            using var cmd = Command(connection, sql, args);
            return cmd.ExecuteScalar() as string;
        });
    }

    /// <summary>The one value a query that always answers a value (a count, a counter) returns.</summary>
    public static T Scalar<T>(DuckDBConnection connection, string sql, params object?[] args) where T : struct
    {
        return StoreFaults.Translating(() =>
        {
            using var cmd = Command(connection, sql, args);
            return cmd.ExecuteScalar() is T value
                ? value
                : throw new InvalidOperationException($"Expected a {typeof(T).Name} from: {sql}");
        });
    }

    public static string? GetStringOrNull(this DbDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    private static DuckDBCommand Command(DuckDBConnection connection, string sql, object?[] args)
    {
        var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var arg in args)
            cmd.Parameters.Add(new DuckDBParameter { Value = arg });
        return cmd;
    }
}
