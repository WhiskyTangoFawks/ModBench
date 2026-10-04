namespace MEditService.Index;

/// <summary>The record filter: the matches of one SQL query, and the records holding a match in the
/// match's own plugin so it stays reachable beneath them.</summary>
internal sealed class RecordFilter(Store store)
{
    private const string Holders = "_filter_holders";
    internal const string Matches = "_filter";

    public bool Active { get; private set; }

    public string? Listing => Active ? KeptBy("r") : null;

    public string AlsoKeeps(string alias, string formKeyColumn = "form_key") =>
        Active ? $" AND {KeptBy(alias, formKeyColumn)}" : "";

    private static string KeptBy(string alias, string formKeyColumn = "form_key") => $"""
        ({alias}.{formKeyColumn} IN (SELECT form_key FROM {Matches})
         OR EXISTS (SELECT 1 FROM {Holders} fh
                    WHERE fh.form_key = {alias}.{formKeyColumn} AND fh.plugin = {alias}.plugin AND fh.origin = {alias}.origin))
        """;

    public void Set(string? sql)
    {
        if (sql is null)
        {
            Active = false;
            return;
        }

        var connection = store.Connection;
        if (SqlDoor.RefusalOf(connection, sql) is { } refusal)
            throw new ArgumentException(refusal);

        store.CreateRecordTypeViews();
        using var probeCmd = connection.CreateCommand();
        // The newline keeps a trailing line comment in the filter from swallowing the wrapper.
        probeCmd.CommandText = $"SELECT * FROM ({sql}\n) __probe LIMIT 0";
        using var probeReader = probeCmd.ExecuteReader();
        bool hasFormKey = Enumerable.Range(0, probeReader.FieldCount)
            .Any(i => string.Equals(probeReader.GetName(i), "form_key", StringComparison.OrdinalIgnoreCase));

        if (!hasFormKey)
            throw new ArgumentException("Filter SQL must return a form_key column");

        DuckDbSql.ExecuteFor(connection, $"CREATE OR REPLACE TABLE {Matches} AS ({sql}\n)");
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
    }
}
