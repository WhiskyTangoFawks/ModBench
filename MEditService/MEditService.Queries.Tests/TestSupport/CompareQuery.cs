using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.TestSupport;

internal sealed record Classified(
    ConflictAll ConflictAll, IReadOnlyDictionary<string, ConflictThis> PluginStates, IReadOnlyList<FieldDiff> Diffs);

/// <summary>The compare query over one record's override stack, hand-built from the copies a test
/// names: conflict classification as the query answers it.</summary>
internal static class CompareQuery
{
    internal static Classified Classify(IReadOnlyList<RecordDetail> records,
        IReadOnlyDictionary<string, RecordLookupEntry>? resolvable = null)
    {
        var addresses = records.Select(r => new PluginAddress(r.Plugin, r.Origin)).ToList();
        var rows = records.Select((r, i) => new FakeRow(new RecordDocument(r.FormKey, addresses[i], r.LoadOrderIndex, r.IsWinner, r.EditorId, r.RecordType, null,
                [.. r.Fields.Select(f => new Codec.Schema.FieldValue(f.Metadata, f.Value, f.CheckError))], r.IsPartialForm, r.ParseDiagnosis))).ToList();
        var opened = addresses.ToDictionary(a => a,
            _ => new PluginContent(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: [], RecordCount: 1, IsMedium: false),
            PluginAddress.Comparer);
        var entries = records.Select(r => new LoadOrderEntry(r.Plugin, r.Plugin, r.Origin, r.LoadOrderIndex, Enabled: true, Winning: r.IsWinner)).ToArray();
        var service = QueryHost.Records(
            new FakeIndex(new FakeReads(opened, rows) { Lookups = resolvable }), FakeLoadOrder.Of(GameRelease.Fallout4, entries));

        var compare = service.GetCompare(records[0].FormKey)
            ?? throw new InvalidOperationException($"Expected {records[0].FormKey} to resolve to a compare result.");
        var states = compare.Overrides.Where(o => o.ConflictThis.HasValue)
            .ToDictionary(o => ColumnKey.Of(o.Plugin, o.Origin), o => o.ConflictThis.GetValueOrDefault());
        return new Classified(compare.ConflictAll, states, compare.Diffs);
    }
}
