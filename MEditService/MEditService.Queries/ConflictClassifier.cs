using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Queries;

public sealed class ConflictClassifier(ILogger<ConflictClassifier>? logger = null)
{
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    // resolveFormKey (ADR-0005): the O(1) lookup, batched once per Classify so every formKey leaf's
    // Resolutions is populated in this pass; null leaves Resolutions empty. pluginParticipates
    // (ADR-0013) is keyed by ColumnKey.Of; null means every plugin participates.
    public ClassifyResult Classify(
        IReadOnlyList<RecordDetail> conflictingRecords,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters,
        GameRelease release,
        Func<string, RecordLookupEntry?>? resolveFormKey = null,
        IReadOnlyDictionary<string, bool>? pluginParticipates = null)
    {
        // ADR-0013: a non-participating plugin's override never contributes to conflict
        // classification — filtered out before OnlyOne/winner/diff computation below, not just
        // masked in the result, so it can't leak into pluginMasters/IsInjected either.
        conflictingRecords = ConflictRules.FilterParticipating(
            conflictingRecords, r => ColumnKey.Of(r.Plugin, r.Origin), pluginParticipates);

        if (conflictingRecords.Count == 0)
            return new ClassifyResult(ConflictAll.OnlyOne, new Dictionary<string, ConflictThis>(), []);

        // The fallback for a field no column carries; a lone override is its own winner whatever
        // its IsWinner flag says.
        var winner = conflictingRecords.Count == 1
            ? conflictingRecords[0]
            : conflictingRecords.FirstOrDefault(o => o.IsWinner)
                ?? throw new InvalidOperationException(
                    $"No winner in {conflictingRecords.Count} overrides for FormKey '{conflictingRecords[0].FormKey}'");

        var ctx = new DiffContext(
            MasterColumn: Column(conflictingRecords[0]),
            RecordWinnerColumn: Column(winner),
            ColumnOrder: [.. conflictingRecords.Select(r => (Column(r), r.LoadOrderIndex))],
            PartialFormColumns: conflictingRecords.Where(r => r.IsPartialForm).Select(Column).ToHashSet(StringComparer.Ordinal),
            FormKey: conflictingRecords[0].FormKey,
            Logger: _logger,
            ResolveFormKey: resolveFormKey,
            Release: release);
        var diffs = RecordChildren(conflictingRecords, ctx);

        if (conflictingRecords.Count == 1)
            return new ClassifyResult(
                ConflictAll.OnlyOne,
                new Dictionary<string, ConflictThis> { [ctx.MasterColumn] = ConflictThis.OnlyOne },
                diffs);

        var conflictAll = ConflictRules.Reduce(diffs.SelectMany(d => d.CellStates.Values));

        // ADR-0012: keyed by the compound column identity, not the bare plugin — two overrides
        // sharing a filename but differing in origin must land as two independent entries here,
        // not collide (ToDictionary would throw on a literal duplicate key).
        var pluginConflictThis = conflictingRecords.ToDictionary(
            Column, o => ConflictRules.AggregateThis(Column(o), ctx.MasterColumn, diffs.Select(d => d.CellStates)));

        // Escalates an existing Override/Conflict to Critical; never overrides a NoConflict result
        // (a content-identical injected record isn't a real conflict — see xeMainForm.pas
        // ConflictLevelForNodeDatas).
        if (conflictAll != ConflictAll.NoConflict && ConflictRules.IsInjected(conflictingRecords, pluginMasters))
            conflictAll = ConflictAll.ConflictCritical;

        return new ClassifyResult(conflictAll, pluginConflictThis, diffs);
    }

    private static string Column(RecordDetail record) => ColumnKey.Of(record.Plugin, record.Origin);

    private const int MaxArrayChildCount = 500;

    // MasterColumn (ADR-0012) is the compound ColumnKey.Of identity, so no plain-plugin comparison
    // can match the wrong column.
    private sealed record DiffContext(
        string MasterColumn,
        string RecordWinnerColumn,
        IReadOnlyList<(string Column, int LoadOrderIndex)> ColumnOrder,
        IReadOnlySet<string> PartialFormColumns,
        string FormKey,
        ILogger Logger,
        Func<string, RecordLookupEntry?>? ResolveFormKey,
        GameRelease Release);

    // One node of the diff tree, at whatever depth the walk reached it. absentMeansDefault is false
    // for an array element, which the codec never omits for equalling its default.
    private static FieldDiff DiffNode(
        string label,
        Dictionary<string, object?> values,
        Dictionary<string, FieldMetadata> shapes,
        bool absentMeansDefault,
        DiffContext ctx)
    {
        var carrying = ctx.ColumnOrder.Where(c => values.GetValueOrDefault(c.Column) != null).ToList();
        var winnerColumn = carrying.Count > 0 ? carrying.MaxBy(c => c.LoadOrderIndex).Column : ctx.RecordWinnerColumn;
        var shape = shapes[winnerColumn];

        var cellStates = ConflictRules.ComputeCellStates(
            values, ctx.MasterColumn, ctx.ColumnOrder,
            (a, b) => DocumentNodes.SameNode(a, b, ComparesUnordered(shape), absentMeansDefault ? shape : null));

        List<FieldDiff>? children = null;
        if (shape.Fields is { } members) children = StructChildren(members, values, ctx);
        else if (shape.ElementType is { } shapeElement) children = ArrayChildren(shape, shapeElement, label, values, ctx);

        // Escalate is associative and commutative over {NoConflict, Override, Conflict} (Reduce
        // never produces the terminal states), so folding children equals reducing the whole
        // subtree at once.
        var conflictAll = (children ?? []).Aggregate(
            ConflictRules.Reduce(cellStates.Values), (all, child) => ConflictRules.Escalate(all, child.ConflictAll));

        var links = LinkFacts(shapes, values, ctx);
        return new FieldDiff(
            label, values, winnerColumn, cellStates, conflictAll, children, links.Resolutions, links.CheckErrors);
    }

    // A table of several record classes carries the document's discriminator as a column, and a
    // column whose type varies by class reads through it.
    private static List<FieldDiff> RecordChildren(IReadOnlyList<RecordDetail> records, DiffContext ctx)
    {
        var recordClass = records.ToDictionary(
            Column, r => FormReferences.ExtractString(MemberValue(r, LoquiUnions.UnionTypeDiscriminator)));
        var memberMeta = records[0].Fields.ToDictionary(f => f.Metadata.Name, f => f.Metadata);
        var diffs = new List<FieldDiff>();
        foreach (var member in memberMeta.Values)
        {
            // A Partial Form override's fields are excluded as if null (ADR-0018), so they fall
            // through to the previous non-partial override with no new state.
            var values = records.ToDictionary(Column, r => r.IsPartialForm ? null : MemberValue(r, member.Name));
            if (values.Values.All(v => v == null)) continue;
            var shapes = recordClass.ToDictionary(kv => kv.Key, kv => DocumentNodes.Variant(member, kv.Value));
            diffs.Add(DiffNode(member.Name, values, shapes, absentMeansDefault: true, ctx));
        }
        return diffs;
    }

    private static List<FieldDiff>? StructChildren(
        IReadOnlyList<FieldMetadata> members, Dictionary<string, object?> owners, DiffContext ctx)
    {
        var children = new List<FieldDiff>();
        foreach (var member in members)
        {
            var values = owners.ToDictionary(kv => kv.Key, kv => (object?)MemberValue(kv.Value, member.Name));
            if (values.Values.All(v => v == null)) continue;
            var shapes = owners.ToDictionary(
                kv => kv.Key, kv => DocumentNodes.VariantFor(member, kv.Value as JsonElement?));
            children.Add(DiffNode(member.Name, values, shapes, absentMeansDefault: true, ctx));
        }
        return children.Count > 0 ? children : null;
    }

    // Keyed, sorted and positional alignment are one union-by-key build over three key functions, so
    // an element one plugin lacks is an absence at its key, not a shift. Keyed rows come out in key
    // order.
    private static List<FieldDiff>? ArrayChildren(
        FieldMetadata array, FieldMetadata element, string label, Dictionary<string, object?> values, DiffContext ctx)
    {
        Func<JsonElement, int, ElementKey?> keyOf;
        if (array.KeyMembers is { } keyMembers) keyOf = (e, _) => ElementKey.Of(e, keyMembers, element);
        // A non-string element (the JSON null of a never-set slot) is not a row.
        else if (ComparesUnordered(array)) keyOf = (e, _) => e.ValueKind == JsonValueKind.String ? ElementKey.OfValue(DocumentNodes.StringValueOf(e)) : null;
        else keyOf = (_, index) => ElementKey.OfValue($"[{index}]");

        var byColumn = new Dictionary<string, Dictionary<string, object?>>(StringComparer.Ordinal);
        var union = new List<ElementKey>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (column, _) in ctx.ColumnOrder)
        {
            if (values.GetValueOrDefault(column) is not JsonElement { ValueKind: JsonValueKind.Array } elements) continue;
            var lookup = new Dictionary<string, object?>(StringComparer.Ordinal);
            var index = 0;
            foreach (var e in elements.EnumerateArray())
            {
                // A second element sharing a key: the first wins — the write path refuses such a
                // pair, but another tool's plugin can hold one.
                if (keyOf(e, index++) is { } key && lookup.TryAdd(key.Text, e) && seen.Add(key.Text)) union.Add(key);
            }
            byColumn[column] = lookup;
        }

        if (union.Count > MaxArrayChildCount)
        {
            ctx.Logger.LogWarning(
                "Array field {Field} on {FormKey} has {Count} elements across plugins — exceeding MaxArrayChildCount ({Max}), falling back to opaque display",
                label, ctx.FormKey, union.Count, MaxArrayChildCount);
            return null;
        }
        if (union.Count == 0) return null;
        if (array.KeyMembers != null) union.Sort((a, b) => a.CompareTo(b));

        var shapes = values.Keys.ToDictionary(column => column, _ => element);
        return [.. union.Select(key => DiffNode(
            key.Text,
            values.Keys.ToDictionary(
                column => column,
                column => byColumn.TryGetValue(column, out var lookup) && lookup.TryGetValue(key.Text, out var e) ? e : null),
            shapes, absentMeansDefault: false, ctx))];
    }

    // ADR-0005: Resolutions are a scalar formKey node's alone, never aggregated up from Children, so
    // a dangling sibling can't hide a live hyperlink beside it. A check error is the node's whole
    // subtree's.
    private static (Dictionary<string, FormKeyResolution>? Resolutions, Dictionary<string, string>? CheckErrors) LinkFacts(
        Dictionary<string, FieldMetadata> shapes, Dictionary<string, object?> values, DiffContext ctx)
    {
        if (ctx.ResolveFormKey == null) return (null, null);

        ResolvedFormKey? Resolve(string formKey) =>
            ctx.ResolveFormKey(formKey) is { } entry ? new ResolvedFormKey(entry.RecordType, entry.EditorId) : null;

        var resolutions = new Dictionary<string, FormKeyResolution>();
        var checkErrors = new Dictionary<string, string>();
        foreach (var (column, value) in values)
        {
            // A Partial Form override asserts nothing about the fields it omits (ADR-0018), so its
            // absent value is not an unset link to report.
            if (ctx.PartialFormColumns.Contains(column)) continue;
            var meta = shapes[column];
            if (CheckErrorBuilder.Build(meta, value as JsonElement?, Resolve, ctx.Release) is { } error)
                checkErrors[column] = error;
            if (meta.Type != "formKey") continue;
            var fk = FormReferences.ExtractString(value);
            if (string.IsNullOrEmpty(fk) || fk == "Null") continue;
            resolutions[column] = FormKeyResolution.From(fk, Resolve(fk), meta.ValidFormKeyTypes, ctx.Release);
        }
        return (resolutions.Count > 0 ? resolutions : null, checkErrors.Count > 0 ? checkErrors : null);
    }

    // xEdit's wbArrayS keyed by the element itself: a pure-link array's order carries no meaning, so
    // two spellings of one set are one value. Read off the element type at every depth.
    private static bool ComparesUnordered(FieldMetadata meta) => meta.ElementType?.Type == "formKey";

    private static object? MemberValue(RecordDetail record, string member) =>
        record.Fields.FirstOrDefault(f => f.Metadata.Name == member)?.Value;

    private static JsonElement? MemberValue(object? owner, string member) =>
        owner is JsonElement { ValueKind: JsonValueKind.Object } obj
        && obj.TryGetProperty(member, out var sub)
        && sub.ValueKind != JsonValueKind.Null
            ? sub
            : null;
}
