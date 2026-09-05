using System.Text.Json;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Queries;

public sealed class ConflictClassifier(ILogger<ConflictClassifier>? logger = null)
{
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    // resolveFormKey (ADR-0031): the O(1) lookup, batched once per Classify so every formKey leaf's
    // Resolutions is populated in this pass; null leaves Resolutions empty. pluginParticipates
    // (ADR-0035) is keyed by ColumnKey.Of; null means every plugin participates.
    public ClassifyResult Classify(
        IReadOnlyList<RecordDetail> conflictingRecords,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters,
        GameRelease release,
        Func<string, RecordLookupEntry?>? resolveFormKey = null,
        IReadOnlyDictionary<string, bool>? pluginParticipates = null)
    {
        // ADR-0035: a non-participating plugin's override never contributes to conflict
        // classification — filtered out before OnlyOne/winner/diff computation below, not just
        // masked in the result, so it can't leak into pluginMasters/IsInjectedRecord either.
        conflictingRecords = ConflictRules.FilterParticipating(
            conflictingRecords, r => ColumnKey.Of(r.Plugin, r.Origin), pluginParticipates);

        if (conflictingRecords.Count == 0)
            return new ClassifyResult(ConflictAll.OnlyOne, new Dictionary<string, ConflictThis>(), []);

        if (conflictingRecords.Count == 1)
        {
            var single = conflictingRecords[0];
            var pluginState = new Dictionary<string, ConflictThis> { [ColumnKey.Of(single.Plugin, single.Origin)] = ConflictThis.OnlyOne };
            var fieldNames = single.Fields.Select(f => f.Metadata.Name).ToList();
            var singleCtx = new DiffContext(ColumnKey.Of(single.Plugin, single.Origin), conflictingRecords, _logger, resolveFormKey, release);
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
        var masterColumn = ColumnKey.Of(master.Plugin, master.Origin);
        var ctx = new DiffContext(masterColumn, conflictingRecords, _logger, resolveFormKey, release);
        var diffs = BuildDiffs([.. master.Fields.Select(f => f.Metadata.Name)], conflictingRecords, winner, ctx, sortedArrays);

        var conflictAll = ConflictRules.Reduce(diffs.SelectMany(d => d.CellStates.Values));

        // ADR-0036: keyed by the compound column identity, not the bare plugin — two
        // overrides sharing a filename but differing in origin must land as two independent entries
        // here, not collide (ToDictionary would throw on a literal duplicate key).
        var pluginConflictThis = conflictingRecords.ToDictionary(
            o => ColumnKey.Of(o.Plugin, o.Origin),
            o => AggregateConflictThis(ColumnKey.Of(o.Plugin, o.Origin), masterColumn, diffs));

        // Escalates an existing Override/Conflict to Critical; never overrides a NoConflict result
        // (a content-identical injected record isn't a real conflict — see xeMainForm.pas ConflictLevelForNodeDatas).
        if (conflictAll != ConflictAll.NoConflict && IsInjectedRecord(conflictingRecords, pluginMasters))
            conflictAll = ConflictAll.ConflictCritical;

        return new ClassifyResult(conflictAll, pluginConflictThis, diffs);
    }

    private static ConflictThis AggregateConflictThis(
        string column,
        string masterColumn,
        IReadOnlyList<FieldDiff> diffs)
    {
        if (column == masterColumn) return ConflictThis.Master;

        var states = diffs
            .Where(d => d.CellStates.ContainsKey(column))
            .Select(d => d.CellStates[column])
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
            pluginMasters.TryGetValue(ColumnKey.Of(o.Plugin, o.Origin), out var masters) &&
            !masters.Contains(originPlugin, StringComparer.OrdinalIgnoreCase));
    }

    private const int MaxArrayChildCount = 500;

    // MasterColumn (ADR-0036) is the compound ColumnKey.Of identity, so no plain-plugin comparison
    // can match the wrong column.
    private sealed record DiffContext(
        string MasterColumn,
        IReadOnlyList<RecordDetail> Records,
        ILogger Logger,
        Func<string, RecordLookupEntry?>? ResolveFormKey,
        GameRelease Release);

    private static List<FieldDiff> BuildDiffs(
        IReadOnlyList<string> fieldNames,
        IReadOnlyList<RecordDetail> records,
        RecordDetail winner,
        DiffContext ctx,
        HashSet<string> sortedArrays)
    {
        // Record-wide fallback only — used when *no* plugin has a value for a field (the per-field
        // computation below has nothing to fall through to at that point).
        var recordWinnerColumn = ColumnKey.Of(winner.Plugin, winner.Origin);
        var masterFieldMeta = records[0].Fields
            .ToDictionary(f => f.Metadata.Name, f => f.Metadata);
        // A table of several record classes carries the document's discriminator as a column, and a
        // column whose type varies by class reads through that column's value.
        var recordClass = records.ToDictionary(
            o => ColumnKey.Of(o.Plugin, o.Origin),
            o => o.Fields.FirstOrDefault(f => f.Metadata.Name == LoquiUnions.UnionTypeDiscriminator)?.Value);
        return [.. fieldNames
            .Select(fieldName =>
            {
                // A Partial Form override's fields are excluded as if null (ADR-0016), so they
                // fall through to the previous non-partial override with no new state.
                var values = records.ToDictionary(
                    o => ColumnKey.Of(o.Plugin, o.Origin),
                    o => o.IsPartialForm ? null : o.Fields.FirstOrDefault(f => f.Metadata.Name == fieldName)?.Value);
                // This field's own winner, not the record-wide one, which may carry no value for
                // this field (Partial Form, or a genuinely-null field).
                var fieldWinner = records
                    .Where(r => values.GetValueOrDefault(ColumnKey.Of(r.Plugin, r.Origin)) != null)
                    .MaxBy(r => r.LoadOrderIndex);
                var winnerColumn = fieldWinner != null ? ColumnKey.Of(fieldWinner.Plugin, fieldWinner.Origin) : recordWinnerColumn;
                var winnerValue = values.GetValueOrDefault(winnerColumn);
                var meta = masterFieldMeta.GetValueOrDefault(fieldName);
                var metaByColumn = meta == null
                    ? null
                    : values.Keys.ToDictionary(column => column, column => VariantFor(meta, recordClass.GetValueOrDefault(column)));
                var cellStates = ComputeCellStates(fieldName, values, ctx.MasterColumn, records, sortedArrays, meta);
                var shape = metaByColumn == null ? null : metaByColumn[winnerColumn];
                List<FieldDiff>? children = null;
                if (shape?.Fields != null)
                    children = BuildStructChildren(shape.Fields, values, ctx);
                else if (shape?.ElementType != null)
                    children = BuildArrayChildren(shape, values, ctx, MaxArrayChildCount, fieldName);
                var resolutions = BuildResolutions(metaByColumn, values, ctx.ResolveFormKey, ctx.Release);
                var conflictAll = AggregateConflictAll(cellStates, children);
                return new FieldDiff(fieldName, values, winnerColumn, winnerValue, cellStates, conflictAll, children, resolutions);
            })
            .Where(d => d.Values.Values.Any(v => v != null))];
    }

    // The shape a member has in one column: its own, or the variant that column's leaf names.
    private static FieldMetadata VariantFor(FieldMetadata member, object? leaf) =>
        member.Variants is { } variants
        && FormRefPathBuilder.ExtractString(leaf) is { } name
        && variants.TryGetValue(name, out var variant)
            ? variant
            : member;

    private static FieldMetadata VariantWithin(FieldMetadata member, object? owner) =>
        member.Variants == null
            ? member
            : VariantFor(member, ExtractSubFieldValue(owner, LoquiUnions.UnionTypeDiscriminator));

    // Only a scalar formKey-typed field carries Resolutions — struct/array fields' own Values
    // aren't FormKey strings, and this is never propagated from Children (ADR-0031: no aggregation).
    // Per column, since a union member's leaf can differ across plugins.
    private static Dictionary<string, FormKeyResolution>? BuildResolutions(
        Dictionary<string, FieldMetadata>? metaByColumn,
        Dictionary<string, object?> values,
        Func<string, RecordLookupEntry?>? resolveFormKey,
        GameRelease release)
    {
        if (resolveFormKey == null || metaByColumn == null) return null;

        var resolutions = new Dictionary<string, FormKeyResolution>();
        foreach (var (plugin, value) in values)
        {
            var meta = metaByColumn[plugin];
            if (meta.Type != "formKey") continue;
            var fk = FormRefPathBuilder.ExtractString(value);
            if (string.IsNullOrEmpty(fk) || fk == "Null") continue;
            resolutions[plugin] = FormKeyResolution.From(fk, resolveFormKey(fk), meta.ValidFormKeyTypes, release);
        }
        return resolutions.Count > 0 ? resolutions : null;
    }

    private static List<FieldDiff>? BuildArrayChildren(
        FieldMetadata arrayMeta,
        Dictionary<string, object?> parentValues,
        DiffContext ctx,
        int maxChildren,
        string parentFieldName)
    {
        var elementMeta = arrayMeta.ElementType!;
        var arrays = parentValues.ToDictionary(
            kv => kv.Key,
            kv => kv.Value is System.Text.Json.JsonElement je &&
                  je.ValueKind == System.Text.Json.JsonValueKind.Array
                ? (System.Text.Json.JsonElement?)je : null);

        var builder = new ArrayChildrenBuilder(elementMeta, arrays, ctx, maxChildren, parentFieldName);
        List<FieldDiff>? children;
        if (arrayMeta.KeyMembers is { } keyMembers) children = builder.BuildKeyed(keyMembers);
        else if (elementMeta.IsSortable) children = builder.BuildSorted();
        else children = builder.BuildPositional();
        return children is { Count: > 0 } ? children : null;
    }

    // One array field's per-element diff expansion: a keyed array (FieldMetadata.KeyMembers) diffs
    // by the key its elements carry, a pure-FormLink array by the element value itself, and every
    // other array by position.
    private sealed class ArrayChildrenBuilder(
        FieldMetadata elementMeta,
        Dictionary<string, System.Text.Json.JsonElement?> arrays,
        DiffContext ctx,
        int maxChildren,
        string parentFieldName)
    {
        private readonly IReadOnlyList<RecordDetail> _records = ctx.Records;
        private readonly string _masterColumn = ctx.MasterColumn;
        private readonly ILogger _logger = ctx.Logger;

        /// <summary>Aligns by key, so a script one plugin lacks is an absence at that key rather
        /// than a shift of everything after it. Rows come out in key order, the order the write
        /// path stores them.</summary>
        public List<FieldDiff>? BuildKeyed(IReadOnlyList<string> keyMembers) =>
            BuildAligned(e => ElementKey.Of(e, keyMembers, elementMeta), (a, b) => a.CompareTo(b));

        /// <summary>The element is its own key. A non-string element (the JSON null of a never-set
        /// slot) is not a row. Rows stay in first-seen order across the load order.</summary>
        public List<FieldDiff>? BuildSorted() =>
            BuildAligned(
                e => e.ValueKind == System.Text.Json.JsonValueKind.String ? ElementKey.OfValue(e.GetString()!) : null,
                order: null);

        // One row per key in the union across plugins. A second element sharing a key: the first
        // wins — the write path refuses such a pair, but another tool's plugin can hold one.
        private List<FieldDiff>? BuildAligned(
            Func<System.Text.Json.JsonElement, ElementKey?> keyOf, Comparison<ElementKey>? order)
        {
            var byPlugin = new Dictionary<string, Dictionary<string, object?>>(StringComparer.Ordinal);
            var union = new List<ElementKey>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var r in _records)
            {
                var column = ColumnKey.Of(r.Plugin, r.Origin);
                if (arrays.GetValueOrDefault(column) is not { } array) continue;
                var lookup = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var element in array.EnumerateArray())
                {
                    if (keyOf(element) is not { } key) continue;
                    if (lookup.TryAdd(key.Text, element) && seen.Add(key.Text)) union.Add(key);
                }
                byPlugin[column] = lookup;
            }

            if (union.Count > maxChildren)
            {
                WarnTooLarge(union.Count);
                return null;
            }

            if (order != null) union.Sort(order);

            return [.. union.Select(key => MakeChild(
                key.Text,
                arrays.ToDictionary(
                    kv => kv.Key,
                    kv => byPlugin.TryGetValue(kv.Key, out var lookup) && lookup.TryGetValue(key.Text, out var el)
                        ? el
                        : null)))];
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

        private FieldDiff MakeChild(string label, Dictionary<string, object?> subValues)
        {
            var fieldWinner = _records
                .Where(r => subValues.GetValueOrDefault(ColumnKey.Of(r.Plugin, r.Origin)) != null)
                .MaxBy(r => r.LoadOrderIndex)!;
            var winnerColumn = ColumnKey.Of(fieldWinner.Plugin, fieldWinner.Origin);
            var winnerValue = subValues[winnerColumn];
            var cellStates = ComputeCellStates(label, subValues, _masterColumn, _records, []);
            var childChildren = elementMeta.Fields != null
                ? BuildStructChildren(elementMeta.Fields, subValues, ctx)
                : null;
            var resolutions = BuildResolutions(
                subValues.Keys.ToDictionary(column => column, _ => elementMeta), subValues, ctx.ResolveFormKey, ctx.Release);
            var conflictAll = AggregateConflictAll(cellStates, childChildren);
            return new FieldDiff(label, subValues, winnerColumn, winnerValue, cellStates, conflictAll, childChildren, resolutions);
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

            var fieldWinner = ctx.Records
                .Where(r => subValues.GetValueOrDefault(ColumnKey.Of(r.Plugin, r.Origin)) != null)
                .MaxBy(r => r.LoadOrderIndex)!;

            var winnerColumn = ColumnKey.Of(fieldWinner.Plugin, fieldWinner.Origin);
            var winnerValue = subValues[winnerColumn];
            // A member whose type varies by leaf takes each column's own leaf's shape; its children
            // follow the winner's.
            var metaByColumn = parentValues.ToDictionary(kv => kv.Key, kv => VariantWithin(subField, kv.Value));
            var shape = metaByColumn[winnerColumn];

            List<FieldDiff>? subChildren = null;
            if (shape.IsArray && shape.ElementType != null)
                subChildren = BuildArrayChildren(shape, subValues, ctx, MaxArrayChildCount, subField.Name);
            else if (shape.Fields != null)
                subChildren = BuildStructChildren(shape.Fields, subValues, ctx);

            var cellStates = ComputeCellStates(subField.Name, subValues, ctx.MasterColumn, ctx.Records, [], shape);
            var resolutions = BuildResolutions(metaByColumn, subValues, ctx.ResolveFormKey, ctx.Release);
            var conflictAll = AggregateConflictAll(cellStates, subChildren);
            children.Add(new FieldDiff(subField.Name, subValues, winnerColumn, winnerValue, cellStates, conflictAll, subChildren, resolutions));
        }
        return children.Count > 0 ? children : null;
    }

    private static JsonElement? ExtractSubFieldValue(object? structValue, string subFieldName)
    {
        static JsonElement? NonNull(JsonElement e) =>
            e.ValueKind == JsonValueKind.Null ? null : e;

        return structValue is JsonElement je &&
            je.ValueKind == JsonValueKind.Object &&
            je.TryGetProperty(subFieldName, out var sub)
            ? NonNull(sub)
            : null;
    }

    // Escalate is associative and commutative over {NoConflict, Override, Conflict} (Reduce never
    // produces the terminal states), so folding children equals reducing the whole subtree at once.
    private static ConflictAll AggregateConflictAll(
        IReadOnlyDictionary<string, ConflictThis> ownCellStates, IReadOnlyList<FieldDiff>? children)
    {
        var result = ConflictRules.Reduce(ownCellStates.Values);
        if (children == null) return result;
        foreach (var child in children)
            result = ConflictRules.Escalate(result, child.ConflictAll);
        return result;
    }

    private static Dictionary<string, ConflictThis> ComputeCellStates(
        string fieldName,
        Dictionary<string, object?> values,
        string masterColumn,
        IReadOnlyList<RecordDetail> records,
        HashSet<string> sortedArrays,
        FieldMetadata? meta = null)
    {
        var isSorted = sortedArrays.Contains(fieldName);
        var columnOrder = records.Select(r => (ColumnKey.Of(r.Plugin, r.Origin), r.LoadOrderIndex)).ToList();
        return ConflictRules.ComputeCellStates(values, masterColumn, columnOrder, (a, b) => ValuesEqual(a, b, isSorted, meta));
    }

    // JsonElement doesn't override Equals() — compare by raw JSON text to handle array/struct fields.
    // For sorted arrays, sort elements before comparing so insertion-order differences don't register
    // as conflicts. The codec omits a member equal to its default, so a member one document omits
    // and another spells as the default are the same value.
    private static bool ValuesEqual(object? a, object? b, bool isSortedArray = false, FieldMetadata? meta = null)
    {
        if (a is JsonElement ja && b is JsonElement jb)
        {
            if (isSortedArray &&
                ja.ValueKind == JsonValueKind.Array &&
                jb.ValueKind == JsonValueKind.Array)
            {
                if (ja.GetArrayLength() != jb.GetArrayLength()) return false;
                var sortedA = ja.EnumerateArray().Select(e => e.GetRawText()).Order();
                var sortedB = jb.EnumerateArray().Select(e => e.GetRawText()).Order();
                return sortedA.SequenceEqual(sortedB);
            }
            return ja.GetRawText() == jb.GetRawText();
        }
        if (a is null && b is JsonElement onlyB) return IsDefault(onlyB, meta);
        if (b is null && a is JsonElement onlyA) return IsDefault(onlyA, meta);
        return Equals(a, b);
    }

    // What the codec omits: a zero number, false, an empty list or object, and a link to nothing.
    private static bool IsDefault(JsonElement value, FieldMetadata? meta) => value.ValueKind switch
    {
        JsonValueKind.Number => value.GetRawText().Trim('-', '0', '.') is "" or "e0",
        JsonValueKind.False => true,
        JsonValueKind.String => meta?.Type == "formKey" && value.GetString() == "Null",
        JsonValueKind.Array => value.GetArrayLength() == 0,
        JsonValueKind.Object => !value.EnumerateObject().Any(),
        _ => false,
    };
}
