using MEditService.LoadOrder;
using MEditService.RecordIndex.Store;

namespace MEditService.RecordIndex;

/// <summary>A copy a read has found, and the length of its document.</summary>
internal readonly record struct CopySize(string FormKey, PluginAddress Plugin, long Length);

/// <summary>A copy as the record index stores it.</summary>
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
                yield return [.. record.Select(copy => read[copy.FormKey].First(stored => PluginAddress.Comparer.Equals(stored.Plugin, copy.Plugin)))];
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

    // A filter naming each copy takes over ten times as long as one naming their keys, plugins and origins, so the
    // copies are matched after the read.
    private static ILookup<string, StoredCopy> Bodies(ReadContext context, List<IReadOnlyList<CopySize>> batch)
    {
        var copies = batch.SelectMany(record => record).ToList();
        var formKeys = copies.Select(copy => copy.FormKey).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var plugins = copies.Select(copy => copy.Plugin.Name).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var origins = copies.Select(copy => copy.Plugin.Origin).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        string[] values = [.. formKeys, .. plugins, .. origins];
        static string Parameters(int from, int count) => string.Join(", ", Enumerable.Range(from + 1, count).Select(i => $"${i}"));
        return context.Rows($"""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, parse_diagnosis, record_type, working_tree_state
            FROM {TableDdlBuilder.PluginRecordsView}
            WHERE form_key IN ({Parameters(0, formKeys.Count)})
              AND plugin IN ({Parameters(formKeys.Count, plugins.Count)})
              AND origin IN ({Parameters(formKeys.Count + plugins.Count, origins.Count)})
            """, reader => new StoredCopy(
                reader.GetString(0), new PluginAddress(reader.GetString(1), reader.GetString(2)), reader.IsDBNull(3) ? null : reader.GetInt32(3), reader.GetBoolean(4),
                reader.GetStringOrNull(5), reader.GetString(6), reader.GetStringOrNull(7), reader.GetString(8), reader.GetString(9)),
            values)
            .ToLookup(copy => copy.FormKey, StringComparer.OrdinalIgnoreCase);
    }
}
