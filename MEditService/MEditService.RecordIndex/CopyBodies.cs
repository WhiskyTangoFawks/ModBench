using System.Globalization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Store;

namespace MEditService.RecordIndex;

internal readonly record struct CopySize(string FormKey, PluginAddress Plugin, long Length);

internal sealed record StoredCopy(
    string FormKey, PluginAddress Plugin, int? LoadOrderIndex, bool IsWinner, string? EditorId, string Body,
    string? ParseDiagnosis, string RecordType, string WorkingTreeState);

/// <summary>The one read that carries documents out of the record index (ADR-0010). It reads whole records'
/// copies in batches bounded by size, so its memory grows with its largest record, never with how many it reads.</summary>
internal static class CopyBodies
{
    /// <summary>Each of <paramref name="records"/>' copies, in the order given, a record's copies never split
    /// between two batches.</summary>
    public static IEnumerable<List<StoredCopy>> Read(ReadContext context, IEnumerable<IReadOnlyList<CopySize>> records, long batchBytes)
    {
        foreach (var batch in Batches(records, batchBytes))
        {
            var read = Bodies(context, batch);
            foreach (var record in batch)
                yield return [.. record.Select(copy => read[copy.FormKey].FirstOrDefault(stored => PluginAddress.Comparer.Equals(stored.Plugin, copy.Plugin))
                    ?? throw new InvalidOperationException(
                        $"Expected the batched read to find {copy.FormKey} in {copy.Plugin.Name} ({copy.Plugin.Origin}), which its read located."))];
        }
    }

    private static IEnumerable<List<IReadOnlyList<CopySize>>> Batches(IEnumerable<IReadOnlyList<CopySize>> records, long batchBytes)
    {
        var batch = new List<IReadOnlyList<CopySize>>();
        long bytes = 0;
        foreach (var record in records)
        {
            var recordBytes = record.Sum(copy => copy.Length);
            if (batch.Count > 0 && bytes + recordBytes > batchBytes)
            {
                yield return batch;
                (batch, bytes) = ([], 0);
            }
            batch.Add(record);
            bytes += recordBytes;
        }
        if (batch.Count > 0) yield return batch;
    }

    // The engine matches a row against a list of parameters one at a time, so past this many keys the list costs more
    // than finding the copies' rows by a join, which reads no document, and reading back those rows.
    private const int KeysMatchedInTurn = 64;

    /// <summary>A filter on the record index's records, with its values, that holds each of <paramref name="copies"/>
    /// and nothing else, in <paramref name="context"/>'s snapshot.</summary>
    internal static (string Filter, object[] Values) Naming(ReadContext context, IReadOnlyList<RecordAt> copies)
    {
        var formKeys = copies.Select(copy => copy.FormKey).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (formKeys.Count <= KeysMatchedInTurn) return Listing(copies, formKeys);
        var asked = copies.ToHashSet(RecordAt.Comparer);
        var rows = context.Rows(
            $"SELECT rowid, form_key, plugin, origin FROM {TableDdlBuilder.MirrorSchema}.records WHERE form_key IN (SELECT unnest($1::VARCHAR[]))",
            reader => (Row: reader.GetInt64(0), Copy: new RecordAt(new PluginAddress(reader.GetString(2), reader.GetString(3)), reader.GetString(1))),
            formKeys);
        return (Spanning([.. rows.Where(row => asked.Contains(row.Copy)).Select(row => row.Row).Order()]), []);
    }

    // Constant bounds narrow the scan itself, so it reads no other row's document; a join of row ids reads every row's.
    private static string Spanning(List<long> rows)
    {
        if (rows.Count == 0) return "FALSE";
        List<string> spans = [];
        var from = rows[0];
        for (var i = 1; i <= rows.Count; i++)
        {
            if (i < rows.Count && rows[i] == rows[i - 1] + 1) continue;
            spans.Add(string.Create(CultureInfo.InvariantCulture, $"rowid BETWEEN {from} AND {rows[i - 1]}"));
            if (i < rows.Count) from = rows[i];
        }
        return $"({string.Join(" OR ", spans)})";
    }

    // An OR naming each copy takes ten times as long as lists of keys, plugins and origins, which narrow the scan.
    // The list of copies drops a key the batch asked of another plugin. No FormKey or filename holds a '/'.
    private static (string Filter, object[] Values) Listing(IReadOnlyList<RecordAt> copies, List<string> formKeys)
    {
        var plugins = copies.Select(copy => copy.Plugin.Name).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var origins = copies.Select(copy => copy.Plugin.Origin).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        List<string> named = [.. copies.Select(copy => $"{copy.FormKey}/{copy.Plugin.Name}/{copy.Plugin.Origin}")];
        static string Parameters(int from, int count) => string.Join(", ", Enumerable.Range(from + 2, count).Select(i => $"${i}"));
        return ($"""
            form_key IN ({Parameters(0, formKeys.Count)})
              AND plugin IN ({Parameters(formKeys.Count, plugins.Count)})
              AND origin IN ({Parameters(formKeys.Count + plugins.Count, origins.Count)})
              AND list_contains($1::VARCHAR[], form_key || '/' || plugin || '/' || origin)
            """, [named, .. formKeys, .. plugins, .. origins]);
    }

    private static ILookup<string, StoredCopy> Bodies(ReadContext context, List<IReadOnlyList<CopySize>> batch)
    {
        var (filter, values) = Naming(context, [.. batch.SelectMany(record => record).Select(copy => new RecordAt(copy.Plugin, copy.FormKey))]);
        return context.Rows($"""
            SELECT r.form_key, r.plugin, r.origin, p.load_order_idx, w.form_key IS NOT NULL, r.editor_id, r.body, r.parse_diagnosis, r.record_type, r.working_tree_state
            FROM (SELECT form_key, plugin, origin, editor_id, body, parse_diagnosis, record_type, working_tree_state
                  FROM {TableDdlBuilder.MirrorSchema}.records WHERE {filter}) r
            {TableDdlBuilder.RegisteredJoin("r", "plugin", "origin")}
            {TableDdlBuilder.WinnerJoin("r", "plugin", "origin")}
            """, reader => new StoredCopy(
                reader.GetString(0), new PluginAddress(reader.GetString(1), reader.GetString(2)), reader.IsDBNull(3) ? null : reader.GetInt32(3), reader.GetBoolean(4),
                reader.GetStringOrNull(5), reader.GetString(6), reader.GetStringOrNull(7), reader.GetString(8), reader.GetString(9)),
            values)
            .ToLookup(copy => copy.FormKey, StringComparer.OrdinalIgnoreCase);
    }
}
