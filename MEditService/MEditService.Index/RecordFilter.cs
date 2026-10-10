using System.Data.Common;
using DuckDB.NET.Data;
namespace MEditService.Index;

/// <summary>The record filter: the matches of one SQL query, and the records holding a match in the
/// match's own plugin so it stays reachable beneath them.</summary>
internal sealed class RecordFilter(Store store)
{
    private const string Holders = "_filter_holders";
    private const string Matches = "_filter";

    public bool Active { get; private set; }

    public string? Listing => Active ? KeptBy("r") : null;

    public static string Matching => $"form_key IN (SELECT form_key FROM {Matches})";

    public string AlsoKeeps(string alias, string formKeyColumn = "form_key") =>
        Active ? $" AND {KeptBy(alias, formKeyColumn)}" : "";

    private static string KeptBy(string alias, string formKeyColumn = "form_key") => $"""
        ({alias}.{formKeyColumn} IN (SELECT form_key FROM {Matches})
         OR EXISTS (SELECT 1 FROM {Holders} fh
                    WHERE fh.form_key = {alias}.{formKeyColumn} AND fh.plugin = {alias}.plugin AND fh.origin = {alias}.origin))
        """;

    /// <summary>Why the SQL cannot be a filter, or null once it is the filter in force; null clears it.</summary>
    public string? Set(string? sql)
    {
        if (sql is null)
        {
            Active = false;
            return null;
        }

        var connection = store.Connection;
        if (SqlDoor.RefusalOf(connection, sql) is { } refusal)
            return refusal;

        store.CreateRecordTypeViews();
        try
        {
            if (!ReturnsFormKey(connection, sql)) return "Filter SQL must return a form_key column";
            DuckDbSql.ExecuteFor(connection, $"CREATE OR REPLACE TABLE {Matches} AS ({sql}\n)");
        }
        catch (DbException ex)
        {
            return ex.Message;
        }
        DuckDbSql.ExecuteFor(connection, $"""
            CREATE OR REPLACE TABLE {Holders} AS
            WITH RECURSIVE held AS (SELECT plugin, origin, parent, child FROM ({NavigatorSql.Held}) h),
            holders(plugin, origin, form_key) AS (
                SELECT held.plugin, held.origin, held.parent FROM held
                JOIN {Matches} m ON held.child = m.form_key
                UNION
                SELECT held.plugin, held.origin, held.parent FROM held
                JOIN holders h ON held.child = h.form_key AND held.plugin = h.plugin AND held.origin = h.origin
            )
            SELECT plugin, origin, form_key FROM holders
            """);
        Active = true;
        return null;
    }

    private static bool ReturnsFormKey(DuckDBConnection connection, string sql)
    {
        using var probeCmd = connection.CreateCommand();
        // The newline keeps a trailing line comment in the filter from swallowing the wrapper.
        probeCmd.CommandText = $"SELECT * FROM ({sql}\n) __probe LIMIT 0";
        using var probeReader = probeCmd.ExecuteReader();
        return Enumerable.Range(0, probeReader.FieldCount)
            .Any(i => string.Equals(probeReader.GetName(i), "form_key", StringComparison.OrdinalIgnoreCase));
    }
}
