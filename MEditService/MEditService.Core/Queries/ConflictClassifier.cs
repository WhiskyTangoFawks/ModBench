using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Queries;

public sealed class ConflictClassifier : IConflictClassifier
{
    private readonly ILogger _logger;

    public ConflictClassifier(ILogger<ConflictClassifier>? logger = null)
        => _logger = (ILogger?)logger ?? NullLogger.Instance;

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
        var masterValues = IndexByName(master.Fields);
        var sortedArrays = conflictingRecords
            .SelectMany(r => r.Fields)
            .Where(f => f.Metadata.ElementType?.IsSortable == true)
            .Select(f => f.Metadata.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var diffs = BuildDiffs(master.Fields.Select(f => f.Metadata.Name).ToList(), conflictingRecords, winner, master.Plugin, sortedArrays);

        var conflictAll = ComputeConflictAll(master.Plugin, masterValues, conflictingRecords, diffs, sortedArrays);

        var pluginConflictThis = conflictingRecords.ToDictionary(
            o => o.Plugin,
            o => AggregateConflictThis(o.Plugin, master.Plugin, diffs));

        if (IsInjectedRecord(conflictingRecords, pluginMasters))
            conflictAll = ConflictAll.ConflictCritical;

        return new ClassifyResult(conflictAll, pluginConflictThis, diffs);
    }

    private static ConflictAll ComputeConflictAll(
        string masterPlugin,
        Dictionary<string, object?> masterValues,
        IReadOnlyList<RecordDetail> overrides,
        IReadOnlyList<FieldDiff> diffs,
        HashSet<string> sortedArrays)
    {
        var hasAnyChange = overrides.Skip(1).Any(o =>
            o.Fields.Any(f =>
                f.Value != null &&
                !ValuesEqual(f.Value, masterValues.GetValueOrDefault(f.Metadata.Name), sortedArrays.Contains(f.Metadata.Name))));

        if (!hasAnyChange) return ConflictAll.NoConflict;

        var hasConflict = diffs.Any(d =>
            d.Values
                .Where(kv => kv.Key != masterPlugin && kv.Value != null)
                .Select(kv => kv.Value?.ToString())
                .Distinct().Skip(1).Any());

        return hasConflict ? ConflictAll.Conflict : ConflictAll.Override;
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
        return fieldNames
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
            .Where(d => d.Values.Values.Any(v => v != null))
            .ToList();
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

        var children = new List<FieldDiff>();

        FieldDiff MakeChild(string label, Dictionary<string, object?> subValues)
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

        void WarnTooLarge(int count) => logger.LogWarning(
            "Array field {Field} on {FormKey} has {Count} elements across plugins — exceeding MaxArrayChildCount ({Max}), falling back to opaque display",
            parentFieldName, records[0].FormKey, count, maxChildren);

        if (elementMeta.IsSortable)
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

            foreach (var key in union)
            {
                var subValues = arrays.ToDictionary(
                    kv => kv.Key,
                    kv =>
                    {
                        if (kv.Value == null) return (object?)null;
                        return kv.Value.Value.EnumerateArray()
                            .Where(e => e.GetString() == key)
                            .Select(e => (object?)e)
                            .FirstOrDefault();
                    });

                children.Add(MakeChild(key, subValues));
            }
        }
        else
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
        }

        return children.Count > 0 ? children : null;
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
            return sub.ValueKind == System.Text.Json.JsonValueKind.Null ? null : sub;
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
        var masterValue = values.GetValueOrDefault(masterPlugin);

        // Field winner: highest load-order plugin with a non-null value for this field.
        var fieldWinner = records
            .Where(r => values.GetValueOrDefault(r.Plugin) != null)
            .MaxBy(r => r.LoadOrderIndex);

        if (fieldWinner == null) return [];

        var cellStates = new Dictionary<string, ConflictThis>();

        foreach (var plugin in records.Select(r => r.Plugin))
        {
            if (plugin == masterPlugin) continue;

            var pluginValue = values.GetValueOrDefault(plugin);
            if (pluginValue == null) continue;

            if (ValuesEqual(pluginValue, masterValue, isSorted))
            {
                cellStates[plugin] = ConflictThis.IdenticalToMaster;
                continue;
            }

            if (plugin == fieldWinner.Plugin)
            {
                var contested = records
                    .Where(r => r.Plugin != masterPlugin && r.Plugin != plugin)
                    .Any(r =>
                    {
                        var v = values.GetValueOrDefault(r.Plugin);
                        return v != null && !ValuesEqual(v, pluginValue, isSorted);
                    });
                cellStates[plugin] = contested ? ConflictThis.ConflictWins : ConflictThis.Override;
            }
            else
            {
                var fieldWinnerValue = values[fieldWinner.Plugin];
                cellStates[plugin] = !ValuesEqual(pluginValue, fieldWinnerValue, isSorted)
                    ? ConflictThis.ConflictLoses
                    : ConflictThis.Override;
            }
        }

        return cellStates;
    }

    private static Dictionary<string, object?> IndexByName(IReadOnlyList<FieldValue> fields) =>
        fields.ToDictionary(f => f.Metadata.Name, f => f.Value);

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
                var sortedA = ja.EnumerateArray().Select(e => e.GetRawText()).OrderBy(x => x);
                var sortedB = jb.EnumerateArray().Select(e => e.GetRawText()).OrderBy(x => x);
                return sortedA.SequenceEqual(sortedB);
            }
            return ja.GetRawText() == jb.GetRawText();
        }
        return Equals(a, b);
    }
}
