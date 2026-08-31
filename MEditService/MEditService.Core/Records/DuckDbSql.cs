using DuckDB.NET.Data;

namespace MEditService.Core.Records;

/// <summary>
/// Parameterized-command plumbing shared by two or more of
/// <see cref="DuckDbRecordIndex"/> and its collaborators (<see cref="IndexStore"/>,
/// <see cref="WorkingTreeOverlay"/>) — the connection is an explicit first parameter, matching the
/// <see cref="DuckDbAppend"/> convention in this same directory. Not a general-purpose
/// home: a member with exactly one consumer belongs on that consumer instead.
/// </summary>
internal static class DuckDbSql
{
    public static string? ScalarString(DuckDBConnection connection, string sql, params string[] values)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        AddParams(cmd, values);
        return cmd.ExecuteScalar() as string;
    }

    public static void ExecuteFor(DuckDBConnection connection, string sql, params string[] values)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        AddParams(cmd, values);
        cmd.ExecuteNonQuery();
    }

    public static void AddParams(DuckDBCommand cmd, IEnumerable<string> values)
    {
        foreach (var v in values)
            cmd.Parameters.Add(new DuckDBParameter { Value = v });
    }
}
