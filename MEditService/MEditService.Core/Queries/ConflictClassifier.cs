using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Queries;

public sealed class ConflictClassifier(ILogger<ConflictClassifier>? logger = null) : IConflictClassifier
{
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    public ClassifyResult Classify(
        IReadOnlyList<RecordDetail> conflictingRecords,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters)
    {
        if (conflictingRecords.Count == 0)
            return new ClassifyResult(ConflictAll.OnlyOne, new Dictionary<string, ConflictThis>(), []);

        if (conflictingRecords.Count == 1)
        {
            var single = conflictingRecords[0];
            var pluginState = new Dictionary<string, ConflictThis> { [single.Plugin] = ConflictThis.OnlyOne };
            var fieldNames = single.Fields.Select(f => f.Metadata.Name).ToList();
            return new ClassifyResult(ConflictAll.OnlyOne, pluginState, BuildDiffs(fieldNames, conflictingRecords, single, single.Plugin, []));
        }

        var master = conflictingRecords[0];
        var winner = conflictingRecords.FirstOrDefault(o => o.IsWinner)
            ?? throw new InvalidOperationException(
                $"No winner in {conflictingRecords.Count} overrides for FormKey '{conflictingRecords[0].FormKey}'");
        var sortedArrays = conflictingRecords
            .SelectMany(r => r.Fields)
            .Where(f => f.Metadata.ElementType?.IsSortable == true)
            .Select(f => f.Metadata.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var diffs = BuildDiffs([.. master.Fields.Select(f => f.Metadata.Name)], conflictingRecords, winner, master.Plugin, sortedArrays);

        var conflictAll = ConflictRules.Reduce(diffs.SelectMany(d => d.CellStates.Values));

        var pluginConflictThis = conflictingRecords.ToDictionary(
            o => o.Plugin,
            o => AggregateConflictThis(o.Plugin, master.Plugin, diffs));

        // Escalates an existing Override/Conflict to Critical; never overrides a NoConflict result
        // (a content-identical injected record isn't a real conflict — see xeMainForm.pas ConflictLevelForNodeDatas).
        if (conflictAll != ConflictAll.NoConflict && IsInjectedRecord(conflictingRecords, pluginMasters))
            conflictAll = ConflictAll.ConflictCritical;

        return new ClassifyResult(conflictAll, pluginConflictThis, diffs);
    }

    private static ConflictThis AggregateConflictThis(
        string plugin,
        string masterPlugin,
        IReadOnlyList<FieldDiff> diffs)
    {
        if (plugin == masterPlugin) return ConflictThis.Master;

        var states = diffs
            .Where(d => d.CellStates.ContainsKey(plugin))
            .Select(d => d.CellStates[plugin])
            .ToList();

        if (states.Count == 0) return ConflictThis.IdenticalToMaster;
        if (states.Contains(ConflictThis.ConflictLoses)) return ConflictThis.ConflictLoses;
        if (states.Contains(ConflictThis.ConflictWins)) return ConflictThis.ConflictWins;
        if (states.Contains(ConflictThis.Override)) return ConflictThis.Override;
        return ConflictThis.IdenticalToMaster;
    }

    private static bool IsInjectedRecord(
        IReadOnlyList<RecordDetail> overrides,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters)
    {
        if (!FormKey.TryFactory(overrides[0].FormKey, out var formKey)) return false;
        var originPlugin = formKey.ModKey.FileName.String;

        return overrides.Skip(1).Any(o =>
            pluginMasters.TryGetValue(o.Plugin, out var masters) &&
            !masters.Contains(originPlugin, StringComparer.OrdinalIgnoreCase));
    }

    private const int MaxArrayChildCount = 500;

    private List<FieldDiff> BuildDiffs(
        IReadOnlyList<string> fieldNames,
        IReadOnlyList<RecordDetail> records,
        RecordDetail winner,
        string masterPlugin,
        HashSet<string> sortedArrays)
    {
        var masterFieldMeta = records[0].Fields
            .ToDictionary(f => f.Metadata.Name, f => f.Metadata);
        return [.. fieldNames
            .Select(fieldName =>
            {
                var values = records.ToDictionary(
                    o => o.Plugin,
                    o => o.Fields.FirstOrDefault(f => f.Metadata.Name == fieldName)?.Value);
                var winnerValue = values.GetValueOrDefault(winner.Plugin);
                var cellStates = ComputeCellStates(fieldName, values, masterPlugin, records, sortedArrays);
                var meta = masterFieldMeta.GetValueOrDefault(fieldName);
                List<FieldDiff>? children = null;
                if (meta?.Fields != null)
                    children = BuildStructChildren(meta.Fields, values, masterPlugin, records, _logger);
                else if (meta?.ElementType != null)
                    children = BuildArrayChildren(meta.ElementType, values, masterPlugin, records, _logger, MaxArrayChildCount, fieldName);
                return new FieldDiff(fieldName, values, winner.Plugin, winnerValue, cellStates, children);
            })
            .Where(d => d.Values.Values.Any(v => v != null))];
    }

    private static List<FieldDiff>? BuildArrayChildren(
        FieldMetadata elementMeta,
        Dictionary<string, object?> parentValues,
        string masterPlugin,
        IReadOnlyList<RecordDetail> records,
        ILogger logger,
        int maxChildren,
        string parentFieldName)
    {
        var arrays = parentValues.ToDictionary(
            kv => kv.Key,
            kv => kv.Value is System.Text.Json.JsonElement je &&
                  je.ValueKind == System.Text.Json.JsonValueKind.Array
                ? (System.Text.Json.JsonElement?)je : null);

        var builder = new ArrayChildrenBuilder(elementMeta, arrays, masterPlugin, records, logger, maxChildren, parentFieldName);
        var children = elementMeta.IsSortable ? builder.BuildSorted() : builder.BuildPositional();
        return children is { Count: > 0 } ? children : null;
    }

    // One array field's per-element diff expansion: sorted arrays diff by element key
    // (union across plugins), unsorted arrays diff by position.
    private sealed class ArrayChildrenBuilder(
        FieldMetadata elementMeta,
        Dictionary<string, System.Text.Json.JsonElement?> arrays,
        string masterPlugin,
        IReadOnlyList<RecordDetail> records,
        ILogger logger,
        int maxChildren,
        string parentFieldName)
    {
        public List<FieldDiff>? BuildSorted()
        {
            var union = records
                .Where(r => arrays.GetValueOrDefault(r.Plugin) != null)
                .SelectMany(r => arrays[r.Plugin]!.Value.EnumerateArray()
                    .Select(e => e.GetString()).OfType<string>())
                .Distinct(StringComparer.Ordinal)
                .ToList();

            if (union.Count > maxChildren)
            {
                WarnTooLarge(union.Count);
                return null;
            }

            var lookups = BuildPluginLookups();

            var children = new List<FieldDiff>();
            foreach (var key in union)
            {
                var subValues = arrays.ToDictionary(
                    kv => kv.Key,
                    kv => lookups.TryGetValue(kv.Key, out var lk) && lk.TryGetValue(key, out var el)
                        ? el : null);

                children.Add(MakeChild(key, subValues));
            }
            return children;
        }

        public List<FieldDiff>? BuildPositional()
        {
            var maxLen = arrays.Values
                .Where(v => v != null)
                .Select(v => v!.Value.GetArrayLength())
                .DefaultIfEmpty(0)
                .Max();
            if (maxLen == 0) return null;

            if (maxLen > maxChildren)
            {
                WarnTooLarge(maxLen);
                return null;
            }

            var children = new List<FieldDiff>();
            for (var i = 0; i < maxLen; i++)
            {
                var subValues = arrays.ToDictionary(
                    kv => kv.Key,
                    kv =>
                    {
                        if (kv.Value == null) return (object?)null;
                        var arr = kv.Value.Value;
                        return arr.GetArrayLength() > i ? (object?)arr[i] : null;
                    });

                children.Add(MakeChild($"[{i}]", subValues));
            }
            return children;
        }

        // One EnumerateArray pass per plugin; avoids O(u×p×e) scan per key in BuildSorted.
        private Dictionary<string, Dictionary<string, object?>> BuildPluginLookups()
        {
            var lookups = new Dictionary<string, Dictionary<string, object?>>();
            foreach (var kv in arrays.Where(kv => kv.Value != null))
            {
                var pluginLookup = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var el in kv.Value!.Value.EnumerateArray())
                {
                    var k = el.GetString();
                    if (k != null) pluginLookup.TryAdd(k, el); // keep first on dup key, matching original FirstOrDefault
                }
                lookups[kv.Key] = pluginLookup;
            }
            return lookups;
        }

        private FieldDiff MakeChild(string label, Dictionary<string, object?> subValues)
        {
            var fieldWinner = records
                .Where(r => subValues.GetValueOrDefault(r.Plugin) != null)
                .MaxBy(r => r.LoadOrderIndex)!;
            var winnerValue = subValues[fieldWinner.Plugin];
            var cellStates = ComputeCellStates(label, subValues, masterPlugin, records, []);
            var childChildren = elementMeta.Fields != null
                ? BuildStructChildren(elementMeta.Fields, subValues, masterPlugin, records, logger)
                : null;
            return new FieldDiff(label, subValues, fieldWinner.Plugin, winnerValue, cellStates, childChildren);
        }

        private void WarnTooLarge(int count) => logger.LogWarning(
            "Array field {Field} on {FormKey} has {Count} elements across plugins — exceeding MaxArrayChildCount ({Max}), falling back to opaque display",
            parentFieldName, records[0].FormKey, count, maxChildren);
    }

    private static List<FieldDiff>? BuildStructChildren(
        IReadOnlyList<FieldMetadata> subFields,
        Dictionary<string, object?> parentValues,
        string masterPlugin,
        IReadOnlyList<RecordDetail> records,
        ILogger logger)
    {
        var children = new List<FieldDiff>();
        foreach (var subField in subFields)
        {
            var subValues = parentValues.ToDictionary(
                kv => kv.Key,
                kv => (object?)ExtractSubFieldValue(kv.Value, subField.Name));

            if (subValues.Values.All(v => v == null)) continue;

            List<FieldDiff>? subChildren = null;
            if (subField.IsArray && subField.ElementType != null)
                subChildren = BuildArrayChildren(subField.ElementType, subValues, masterPlugin, records, logger, MaxArrayChildCount, subField.Name);
            else if (subField.Fields != null)
                subChildren = BuildStructChildren(subField.Fields, subValues, masterPlugin, records, logger);

            var fieldWinner = records
                .Where(r => subValues.GetValueOrDefault(r.Plugin) != null)
                .MaxBy(r => r.LoadOrderIndex)!;

            var winnerValue = subValues[fieldWinner.Plugin];
            var cellStates = ComputeCellStates(subField.Name, subValues, masterPlugin, records, []);
            children.Add(new FieldDiff(subField.Name, subValues, fieldWinner.Plugin, winnerValue, cellStates, subChildren));
        }
        return children.Count > 0 ? children : null;
    }

    private static System.Text.Json.JsonElement? ExtractSubFieldValue(object? structValue, string subFieldName)
    {
        if (structValue is System.Text.Json.JsonElement je &&
            je.ValueKind == System.Text.Json.JsonValueKind.Object &&
            je.TryGetProperty(subFieldName, out var sub))
        {
            return sub.ValueKind == System.Text.Json.JsonValueKind.Null ? null : sub;
        }

        return null;
    }

    private static Dictionary<string, ConflictThis> ComputeCellStates(
        string fieldName,
        Dictionary<string, object?> values,
        string masterPlugin,
        IReadOnlyList<RecordDetail> records,
        HashSet<string> sortedArrays)
    {
        var isSorted = sortedArrays.Contains(fieldName);
        var pluginOrder = records.Select(r => (r.Plugin, r.LoadOrderIndex)).ToList();
        return ConflictRules.ComputeCellStates(values, masterPlugin, pluginOrder, (a, b) => ValuesEqual(a, b, isSorted));
    }

    // JsonElement doesn't override Equals() — compare by raw JSON text to handle array/struct fields.
    // For sorted arrays, sort elements before comparing so insertion-order differences don't register as conflicts.
    private static bool ValuesEqual(object? a, object? b, bool isSortedArray = false)
    {
        if (a is System.Text.Json.JsonElement ja && b is System.Text.Json.JsonElement jb)
        {
            if (isSortedArray &&
                ja.ValueKind == System.Text.Json.JsonValueKind.Array &&
                jb.ValueKind == System.Text.Json.JsonValueKind.Array)
            {
                if (ja.GetArrayLength() != jb.GetArrayLength()) return false;
                var sortedA = ja.EnumerateArray().Select(e => e.GetRawText()).Order();
                var sortedB = jb.EnumerateArray().Select(e => e.GetRawText()).Order();
                return sortedA.SequenceEqual(sortedB);
            }
            return ja.GetRawText() == jb.GetRawText();
        }
        return Equals(a, b);
    }
}
