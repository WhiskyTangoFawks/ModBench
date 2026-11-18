using System.Globalization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Store;

namespace MEditService.RecordIndex;

// A copy_id names its row from one query of a read to the next, where rowid does not: a checkpoint that compacts
// deleted rows renumbers rowids under an open read.
internal readonly record struct CopySize(string FormKey, PluginAddress Plugin, long Length, long CopyId);

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

    // Constant bounds narrow the scan itself, so it reads no other row's document, where a join of ids reads every
    // row's. An OR tests each row against every span, so the spans are searched by halves.
    private static string Spanning(IEnumerable<long> copyIds)
    {
        List<(long From, long To)> spans = [];
        foreach (var id in copyIds.Order())
        {
            if (spans.Count > 0 && spans[^1].To == id - 1) spans[^1] = (spans[^1].From, id);
            else spans.Add((id, id));
        }
        if (spans.Count == 0) return "FALSE";
        var within = Between(spans[0].From, spans[^1].To);
        return spans.Count == 1 ? within : $"{within} AND {Searched(spans, 0, spans.Count)}";
    }

    private static string Searched(List<(long From, long To)> spans, int first, int count)
    {
        if (count == 1) return Between(spans[first].From, spans[first].To);
        var half = count / 2;
        return string.Create(CultureInfo.InvariantCulture,
            $"CASE WHEN copy_id < {spans[first + half].From} THEN {Searched(spans, first, half)} ELSE {Searched(spans, first + half, count - half)} END");
    }

    private static string Between(long from, long to) => string.Create(CultureInfo.InvariantCulture, $"copy_id BETWEEN {from} AND {to}");

    private static ILookup<string, StoredCopy> Bodies(ReadContext context, List<IReadOnlyList<CopySize>> batch) =>
        context.Rows($"""
            SELECT r.form_key, r.plugin, r.origin, p.load_order_idx, w.form_key IS NOT NULL, r.editor_id, r.body, r.parse_diagnosis, r.record_type, r.working_tree_state
            FROM (SELECT form_key, plugin, origin, editor_id, body, parse_diagnosis, record_type, working_tree_state
                  FROM {TableDdlBuilder.MirrorSchema}.records WHERE {Spanning(batch.SelectMany(record => record).Select(copy => copy.CopyId))}) r
            {TableDdlBuilder.RegisteredJoin("r", "plugin", "origin")}
            {TableDdlBuilder.WinnerJoin("r", "plugin", "origin")}
            """, reader => new StoredCopy(
                reader.GetString(0), new PluginAddress(reader.GetString(1), reader.GetString(2)), reader.IsDBNull(3) ? null : reader.GetInt32(3), reader.GetBoolean(4),
                reader.GetStringOrNull(5), reader.GetString(6), reader.GetStringOrNull(7), reader.GetString(8), reader.GetString(9)))
            .ToLookup(copy => copy.FormKey, StringComparer.OrdinalIgnoreCase);
}
