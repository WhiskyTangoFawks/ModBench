using MEditService.Core.Records;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Queries;

public sealed class ConflictClassifier(ILogger<ConflictClassifier>? logger = null) : IConflictClassifier
{
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    public ClassifyResult Classify(
        IReadOnlyList<RecordDetail> conflictingRecords,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters,
        Func<string, RecordLookupEntry?>? resolveFormKey = null)
    {
        if (conflictingRecords.Count == 0)
            return new ClassifyResult(ConflictAll.OnlyOne, new Dictionary<string, ConflictThis>(), []);

        if (conflictingRecords.Count == 1)
        {
            var single = conflictingRecords[0];
            var pluginState = new Dictionary<string, ConflictThis> { [single.Plugin] = ConflictThis.OnlyOne };
            var fieldNames = single.Fields.Select(f => f.Metadata.Name).ToList();
            var singleCtx = new DiffContext(single.Plugin, conflictingRecords, _logger, resolveFormKey);
            return new ClassifyResult(ConflictAll.OnlyOne, pluginState, BuildDiffs(fieldNames, conflictingRecords, single, singleCtx, []));
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
        var ctx = new DiffContext(master.Plugin, conflictingRecords, _logger, resolveFormKey);
        var diffs = BuildDiffs([.. master.Fields.Select(f => f.Metadata.Name)], conflictingRecords, winner, ctx, sortedArrays);

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

        return states switch
        {
            { Count: 0 } => ConflictThis.IdenticalToMaster,
            _ when states.Contains(ConflictThis.ConflictLoses) => ConflictThis.ConflictLoses,
            _ when states.Contains(ConflictThis.ConflictWins) => ConflictThis.ConflictWins,
            _ when states.Contains(ConflictThis.Override) => ConflictThis.Override,
            _ => ConflictThis.IdenticalToMaster,
        };
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

    // Bundles the per-Classify-call context (master plugin, all overrides, logger, and the ADR-0031
    // resolver) that every recursive Build*Children/MakeChild step needs, so adding the resolver
    // didn't push any method over the parameter-count limit.
    private sealed record DiffContext(
        string MasterPlugin,
        IReadOnlyList<RecordDetail> Records,
        ILogger Logger,
        Func<string, RecordLookupEntry?>? ResolveFormKey);

    private static List<FieldDiff> BuildDiffs(
        IReadOnlyList<string> fieldNames,
        IReadOnlyList<RecordDetail> records,
        RecordDetail winner,
        DiffContext ctx,
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
                var cellStates = ComputeCellStates(fieldName, values, ctx.MasterPlugin, records, sortedArrays);
                var meta = masterFieldMeta.GetValueOrDefault(fieldName);
                List<FieldDiff>? children = null;
                if (meta?.Fields != null)
                    children = BuildStructChildren(meta.Fields, values, ctx);
                else if (meta?.ElementType != null)
                    children = BuildArrayChildren(meta.ElementType, values, ctx, MaxArrayChildCount, fieldName);
                var resolutions = BuildResolutions(meta, values, ctx.ResolveFormKey);
                return new FieldDiff(fieldName, values, winner.Plugin, winnerValue, cellStates, children, resolutions);
            })
            .Where(d => d.Values.Values.Any(v => v != null))];
    }

    // Only a scalar formKey-typed field carries Resolutions — struct/array fields' own Values
    // aren't FormKey strings, and this is never propagated from Children (ADR-0031: no aggregation).
    private static Dictionary<string, FormKeyResolution>? BuildResolutions(
        FieldMetadata? meta,
        Dictionary<string, object?> values,
        Func<string, RecordLookupEntry?>? resolveFormKey)
    {
        if (resolveFormKey == null || meta?.Type != "formKey") return null;

        var resolutions = new Dictionary<string, FormKeyResolution>();
        foreach (var (plugin, value) in values)
        {
            // Top-level scalar formKey fields carry a raw string (DuckDB VARCHAR); struct sub-fields
            // and array elements carry a JsonElement (parsed from the struct/array column's JSON) —
            // ExtractString handles both so struct/array leaves resolve exactly like top-level ones.
            var fk = FormRefPathBuilder.ExtractString(value);
            if (string.IsNullOrEmpty(fk) || fk == "Null") continue;
            resolutions[plugin] = FormKeyResolution.From(resolveFormKey(fk), meta.ValidFormKeyTypes);
        }
        return resolutions.Count > 0 ? resolutions : null;
    }

    private static List<FieldDiff>? BuildArrayChildren(
        FieldMetadata elementMeta,
        Dictionary<string, object?> parentValues,
        DiffContext ctx,
        int maxChildren,
        string parentFieldName)
    {
        var arrays = parentValues.ToDictionary(
            kv => kv.Key,
            kv => kv.Value is System.Text.Json.JsonElement je &&
                  je.ValueKind == System.Text.Json.JsonValueKind.Array
                ? (System.Text.Json.JsonElement?)je : null);

        var builder = new ArrayChildrenBuilder(elementMeta, arrays, ctx, maxChildren, parentFieldName);
        var children = elementMeta.IsSortable ? builder.BuildSorted() : builder.BuildPositional();
        return children is { Count: > 0 } ? children : null;
    }

    // One array field's per-element diff expansion: sorted arrays diff by element key
    // (union across plugins), unsorted arrays diff by position.
    private sealed class ArrayChildrenBuilder(
        FieldMetadata elementMeta,
        Dictionary<string, System.Text.Json.JsonElement?> arrays,
        DiffContext ctx,
        int maxChildren,
        string parentFieldName)
    {
        private readonly IReadOnlyList<RecordDetail> _records = ctx.Records;
        private readonly string _masterPlugin = ctx.MasterPlugin;
        private readonly ILogger _logger = ctx.Logger;

        public List<FieldDiff>? BuildSorted()
        {
            var union = _records
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
            var fieldWinner = _records
                .Where(r => subValues.GetValueOrDefault(r.Plugin) != null)
                .MaxBy(r => r.LoadOrderIndex)!;
            var winnerValue = subValues[fieldWinner.Plugin];
            var cellStates = ComputeCellStates(label, subValues, _masterPlugin, _records, []);
            var childChildren = elementMeta.Fields != null
                ? BuildStructChildren(elementMeta.Fields, subValues, ctx)
                : null;
            var resolutions = BuildResolutions(elementMeta, subValues, ctx.ResolveFormKey);
            return new FieldDiff(label, subValues, fieldWinner.Plugin, winnerValue, cellStates, childChildren, resolutions);
        }

        private void WarnTooLarge(int count) => _logger.LogWarning(
            "Array field {Field} on {FormKey} has {Count} elements across plugins — exceeding MaxArrayChildCount ({Max}), falling back to opaque display",
            parentFieldName, _records[0].FormKey, count, maxChildren);
    }

    private static List<FieldDiff>? BuildStructChildren(
        IReadOnlyList<FieldMetadata> subFields,
        Dictionary<string, object?> parentValues,
        DiffContext ctx)
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
                subChildren = BuildArrayChildren(subField.ElementType, subValues, ctx, MaxArrayChildCount, subField.Name);
            else if (subField.Fields != null)
                subChildren = BuildStructChildren(subField.Fields, subValues, ctx);

            var fieldWinner = ctx.Records
                .Where(r => subValues.GetValueOrDefault(r.Plugin) != null)
                .MaxBy(r => r.LoadOrderIndex)!;

            var winnerValue = subValues[fieldWinner.Plugin];
            var cellStates = ComputeCellStates(subField.Name, subValues, ctx.MasterPlugin, ctx.Records, []);
            var resolutions = BuildResolutions(subField, subValues, ctx.ResolveFormKey);
            children.Add(new FieldDiff(subField.Name, subValues, fieldWinner.Plugin, winnerValue, cellStates, subChildren, resolutions));
        }
        return children.Count > 0 ? children : null;
    }

    private static System.Text.Json.JsonElement? ExtractSubFieldValue(object? structValue, string subFieldName)
    {
        static System.Text.Json.JsonElement? NonNull(System.Text.Json.JsonElement e) =>
            e.ValueKind == System.Text.Json.JsonValueKind.Null ? null : e;

        return structValue is System.Text.Json.JsonElement je &&
            je.ValueKind == System.Text.Json.JsonValueKind.Object &&
            je.TryGetProperty(subFieldName, out var sub)
            ? NonNull(sub)
            : null;
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
