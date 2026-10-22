using MEditService.RecordIndex.Store;

namespace MEditService.RecordIndex;

/// <summary>The record filter: the matches of one SQL query, and the records holding a match in the
/// match's own plugin so it stays reachable beneath them.</summary>
internal sealed class FilterMatches(Store.Store store)
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

        store.CreateRecordTypeViews();
        using var context = store.OpenRead();
        if (SqlDoor.RefusalOf(context, sql, TableDdlBuilder.ActiveSchema) is { } refusal)
            return refusal;

        try
        {
            if (!ReturnsFormKey(context, sql)) return "Filter SQL must return a form_key column";
        }
        catch (IndexFaultException ex) when (ex.Fault != IndexFault.Invalidated)
        {
            return ex.Message;
        }
        try
        {
            store.Materialize(Matches, sql);
        }
        catch (IndexFaultException ex) when (ex.Fault == IndexFault.RowValue)
        {
            return ex.Message;
        }
        store.Materialize(Holders, $"""
            WITH RECURSIVE {NavigatorSql.HeldFor(RecordScope.Active, "")},
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

    // Parses and binds the filter's SQL and reads no row, so what it throws is the SQL's own unless the database has been invalidated.
    private static bool ReturnsFormKey(ReadContext context, string sql) =>
        context.ColumnNames(sql).Any(name => string.Equals(name, "form_key", StringComparison.OrdinalIgnoreCase));
}
