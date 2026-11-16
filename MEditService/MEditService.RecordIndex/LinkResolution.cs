using System.Data.Common;
using MEditService.RecordIndex.Store;

namespace MEditService.RecordIndex;

// Every form_lookup query joins `winners`, which no index serves, so each one scans it however few
// FormKeys it asks.
internal static class LinkResolution
{
    // The engine narrows a short IN list of constants to its rows before the winners join, and plans a
    // long one slower than the whole join runs.
    private const int ConstantListLimit = 200;

    internal static RecordLookupEntry? Resolve(ReadContext context, string formKey) =>
        context.Rows("SELECT record_type, editor_id FROM form_lookup WHERE form_key = $1 AND is_winner LIMIT 1",
            reader => Entry(reader), formKey) is [var entry] ? entry : null;

    // Keyed by the FormKey as asked, not as the lookup row spells it: the join ignores filename case.
    internal static Dictionary<string, RecordLookupEntry?> Resolve(ReadContext context, List<string> formKeys)
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
        foreach (var (formKey, entry) in context.Rows(sql,
            reader => (FormKey: reader.GetString(0), Entry: reader.IsDBNull(1) ? (RecordLookupEntry?)null : Entry(reader, 1)), args))
            resolved[formKey] = entry;
        return resolved;
    }

    private static RecordLookupEntry Entry(DbDataReader reader, int first = 0) =>
        new(reader.GetString(first), reader.GetStringOrNull(first + 1));
}

/// <summary>One response's FormKey to (record type, EditorID) lookup against the winning copy. It learns the links of the
/// documents it reads in one pass over the winners; a FormKey it was not told resolves alone.</summary>
internal sealed class LinkResolver(Func<string, RecordLookupEntry?> resolveAlone)
{
    private readonly Dictionary<string, RecordLookupEntry?> _resolved = new(StringComparer.Ordinal);

    internal void Learn(ReadContext context, IEnumerable<string> formKeys)
    {
        List<string> unknown = [.. formKeys.Where(formKey => !_resolved.ContainsKey(formKey)).Distinct(StringComparer.Ordinal)];
        foreach (var (formKey, entry) in LinkResolution.Resolve(context, unknown)) _resolved[formKey] = entry;
    }

    internal RecordLookupEntry? Resolve(string formKey)
    {
        if (!_resolved.TryGetValue(formKey, out var entry)) _resolved[formKey] = entry = resolveAlone(formKey);
        return entry;
    }
}
