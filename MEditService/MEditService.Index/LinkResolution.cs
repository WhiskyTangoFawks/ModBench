using DuckDB.NET.Data;

namespace MEditService.Index;

// Every form_lookup query joins `winners`, which no index serves, so each one scans it however few
// FormKeys it asks.
internal static class LinkResolution
{
    // DuckDB narrows a short IN list of constants to its rows before the winners join, and plans a
    // long one slower than the whole join runs.
    private const int ConstantListLimit = 200;

    // form_references lists an inline child's links under the child's own FormKey. A worldspace's top
    // cell is its one holding with no block directory. No read walks a placed reference.
    private static readonly string SourceIsTheRecordOrAnInlineChild = $"""
        source_form_key IN (
            WITH RECURSIVE carried(form_key) AS (
                SELECT $1
                UNION
                SELECT inline.child FROM {TableDdlBuilder.MirrorSchema}.holdings inline
                JOIN carried ON inline.parent = carried.form_key
                WHERE inline.slot NOT IN ({HoldingSlots.Placed}, {HoldingSlots.Exterior}))
            SELECT form_key FROM carried)
        """;

    /// <summary>Resolves every link form_references lists for <paramref name="formKey"/> and the
    /// records its document carries inline, in any plugin, up front; a FormKey it did not list still
    /// resolves alone.</summary>
    internal static Func<string, RecordLookupEntry?> ForLinksOf(DuckDBConnection connection, string formKey) =>
        ForLinksOf(connection, formKey, alone => Resolve(connection, alone));

    /// <summary>The same, resolving an unlisted FormKey through <paramref name="resolveAlone"/>, for
    /// a resolver that outlives <paramref name="connection"/>.</summary>
    internal static Func<string, RecordLookupEntry?> ForLinksOf(
        DuckDBConnection connection, string formKey, Func<string, RecordLookupEntry?> resolveAlone) =>
        Prefetched(connection, resolveAlone, SourceIsTheRecordOrAnInlineChild, formKey);

    internal static RecordLookupEntry? Resolve(DuckDBConnection connection, string formKey) =>
        DuckDbSql.Rows(
            connection, "SELECT record_type, editor_id FROM form_lookup WHERE form_key = $1 AND is_winner LIMIT 1",
            reader => Entry(reader), formKey) is [var entry] ? entry : null;

    private static Func<string, RecordLookupEntry?> Prefetched(
        DuckDBConnection connection, Func<string, RecordLookupEntry?> resolveAlone, string sourceFilter, params string[] values)
    {
        var linked = Resolve(connection, LinkTargets(connection, sourceFilter, values));
        return FormKeyResolutionCache.Memoize(formKey => linked.TryGetValue(formKey, out var entry) ? entry : resolveAlone(formKey));
    }

    private static List<string> LinkTargets(DuckDBConnection connection, string sourceFilter, string[] values) =>
        DuckDbSql.Rows(
            connection,
            $"SELECT DISTINCT target_form_key FROM {TableDdlBuilder.MirrorSchema}.form_references WHERE {sourceFilter}",
            reader => reader.GetString(0), values);

    // Keyed by the FormKey as asked, not as the lookup row spells it: the join ignores filename case.
    private static Dictionary<string, RecordLookupEntry?> Resolve(DuckDBConnection connection, List<string> formKeys)
    {
        var resolved = new Dictionary<string, RecordLookupEntry?>(StringComparer.Ordinal);
        if (formKeys.Count == 0) return resolved;

        var candidates = "SELECT unnest($1)";
        object?[] args = [formKeys];
        if (formKeys.Count <= ConstantListLimit)
        {
            args = [formKeys, .. formKeys];
            candidates = string.Join(", ", formKeys.Select((_, i) => $"${i + 2}"));
        }
        var sql = $"""
            SELECT k.form_key, l.record_type, l.editor_id
            FROM unnest($1::VARCHAR[]) k(form_key)
            LEFT JOIN (SELECT form_key, record_type, editor_id FROM form_lookup
                       WHERE is_winner AND form_key IN ({candidates})) l
                   ON l.form_key = k.form_key
            """;
        foreach (var (formKey, entry) in DuckDbSql.Rows(
            connection, sql,
            reader => (FormKey: reader.GetString(0), Entry: reader.IsDBNull(1) ? (RecordLookupEntry?)null : Entry(reader, 1)), args))
            resolved[formKey] = entry;
        return resolved;
    }

    private static RecordLookupEntry Entry(DuckDBDataReader reader, int first = 0) =>
        new(reader.GetString(first), reader.GetStringOrNull(first + 1));
}
