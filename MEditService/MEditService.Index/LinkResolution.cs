using DuckDB.NET.Data;
using MEditService.LoadOrder;

namespace MEditService.Index;

// ADR-0005: a read resolves its documents' links in one query, never one per FormKey. Every lookup
// joins `winners`, which no index serves, so each query scans it whatever it asks.
internal static class LinkResolution
{
    // DuckDB narrows a short IN list of constants to its rows before the winners join, and plans a
    // long one slower than the whole join runs: on the vanilla FO4 masters, 6 keys 37 ms against 225.
    private const int ConstantListLimit = 200;

    /// <summary>Resolves every link form_references lists for <paramref name="formKey"/>, in any
    /// plugin, up front; a FormKey it did not list still resolves alone.</summary>
    internal static Func<string, RecordLookupEntry?> ForLinksOf(DuckDBConnection connection, string formKey) =>
        ForLinksOf(connection, formKey, alone => Resolve(connection, alone));

    /// <summary>The same, resolving an unlisted FormKey through <paramref name="resolveAlone"/>, for
    /// a resolver that outlives <paramref name="connection"/>.</summary>
    internal static Func<string, RecordLookupEntry?> ForLinksOf(
        DuckDBConnection connection, string formKey, Func<string, RecordLookupEntry?> resolveAlone) =>
        Prefetched(connection, resolveAlone, "source_form_key = $1", formKey);

    /// <summary>The same, for every link <paramref name="plugin"/>'s records carry.</summary>
    internal static Func<string, RecordLookupEntry?> ForLinksOf(DuckDBConnection connection, PluginAddress plugin) =>
        Prefetched(connection, alone => Resolve(connection, alone), "source_plugin = $1 AND source_origin = $2", plugin.Name, plugin.Origin);

    internal static RecordLookupEntry? Resolve(DuckDBConnection connection, string formKey)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT record_type, editor_id FROM form_lookup WHERE form_key = $1 AND is_winner LIMIT 1";
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? Entry(reader) : null;
    }

    private static Func<string, RecordLookupEntry?> Prefetched(
        DuckDBConnection connection, Func<string, RecordLookupEntry?> resolveAlone, string sourceFilter, params string[] values)
    {
        var linked = Resolve(connection, LinkTargets(connection, sourceFilter, values));
        return FormKeyResolutionCache.Memoize(formKey => linked.TryGetValue(formKey, out var entry) ? entry : resolveAlone(formKey));
    }

    private static List<string> LinkTargets(DuckDBConnection connection, string sourceFilter, string[] values)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT DISTINCT target_form_key FROM {TableDdlBuilder.MirrorSchema}.form_references WHERE {sourceFilter}";
        foreach (var value in values) cmd.Parameters.Add(new DuckDBParameter { Value = value });
        using var reader = cmd.ExecuteReader();
        var targets = new List<string>();
        while (reader.Read()) targets.Add(reader.GetString(0));
        return targets;
    }

    // Keyed by the FormKey as asked, not as the lookup row spells it: the join ignores filename case.
    private static Dictionary<string, RecordLookupEntry?> Resolve(DuckDBConnection connection, List<string> formKeys)
    {
        var resolved = new Dictionary<string, RecordLookupEntry?>(StringComparer.Ordinal);
        if (formKeys.Count == 0) return resolved;

        using var cmd = connection.CreateCommand();
        cmd.Parameters.Add(new DuckDBParameter { Value = formKeys });
        var candidates = "SELECT unnest($1)";
        if (formKeys.Count <= ConstantListLimit)
        {
            foreach (var formKey in formKeys) cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            candidates = string.Join(", ", formKeys.Select((_, i) => $"${i + 2}"));
        }
        cmd.CommandText = $"""
            SELECT k.form_key, l.record_type, l.editor_id
            FROM unnest($1::VARCHAR[]) k(form_key)
            LEFT JOIN (SELECT form_key, record_type, editor_id FROM form_lookup
                       WHERE is_winner AND form_key IN ({candidates})) l
                   ON l.form_key = k.form_key
            """;
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            resolved[reader.GetString(0)] = reader.IsDBNull(1) ? null : Entry(reader, 1);
        return resolved;
    }

    private static RecordLookupEntry Entry(DuckDBDataReader reader, int first = 0) =>
        new(reader.GetString(first), reader.IsDBNull(first + 1) ? null : reader.GetString(first + 1));
}
