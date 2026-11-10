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

    // An OR naming each copy takes ten times as long as lists of keys, plugins and origins, which narrow the scan.
    // The list of copies drops a key the batch asked of another plugin. No FormKey or filename holds a '/'.
    private static ILookup<string, StoredCopy> Bodies(ReadContext context, List<IReadOnlyList<CopySize>> batch)
    {
        var copies = batch.SelectMany(record => record).ToList();
        var formKeys = copies.Select(copy => copy.FormKey).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var plugins = copies.Select(copy => copy.Plugin.Name).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var origins = copies.Select(copy => copy.Plugin.Origin).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        List<string> named = [.. copies.Select(copy => $"{copy.FormKey}/{copy.Plugin.Name}/{copy.Plugin.Origin}")];
        object[] values = [named, .. formKeys, .. plugins, .. origins];
        static string Parameters(int from, int count) => string.Join(", ", Enumerable.Range(from + 2, count).Select(i => $"${i}"));
        return context.Rows($"""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, parse_diagnosis, record_type, working_tree_state
            FROM {TableDdlBuilder.PluginRecordsView}
            WHERE form_key IN ({Parameters(0, formKeys.Count)})
              AND plugin IN ({Parameters(formKeys.Count, plugins.Count)})
              AND origin IN ({Parameters(formKeys.Count + plugins.Count, origins.Count)})
              AND list_contains($1::VARCHAR[], form_key || '/' || plugin || '/' || origin)
            """, reader => new StoredCopy(
                reader.GetString(0), new PluginAddress(reader.GetString(1), reader.GetString(2)), reader.IsDBNull(3) ? null : reader.GetInt32(3), reader.GetBoolean(4),
                reader.GetStringOrNull(5), reader.GetString(6), reader.GetStringOrNull(7), reader.GetString(8), reader.GetString(9)),
            values)
            .ToLookup(copy => copy.FormKey, StringComparer.OrdinalIgnoreCase);
    }
}
