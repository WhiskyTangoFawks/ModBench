using System.Text.Json;
using MEditService.Codec.Schema;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Index.Queries;

internal sealed class ConflictClassifier(ILogger logger)
{

    // resolveFormKey (ADR-0005), batched once per Classify so every formKey leaf's
    // Resolutions fills in this pass. loadOrderFormIds orders a keyed array's FormKeys.
    // outsideTheComparison: columns shown that win no cell and carry no state.
    public ClassifyResult Classify(
        IReadOnlyList<RecordDetail> conflictingRecords,
        GameRelease release,
        Func<string, RecordLookupEntry?> resolveFormKey,
        Func<string, uint?> loadOrderFormIds,
        IReadOnlyList<RecordDetail>? outsideTheComparison = null)
    {
        // The fallback for a field no column carries. Before the winner sweep none is flagged, so
        // the last in load order stands in and the colours are not final.
        var flagged = conflictingRecords.ToList().FindIndex(o => o.IsWinner);
        var winner = flagged >= 0 ? flagged : conflictingRecords.Count - 1;

        var columns = conflictingRecords.Select(Column).ToList();
        var shown = conflictingRecords.Concat(outsideTheComparison ?? []).ToList();
        var shownColumns = shown.Select(Column).ToList();
        var ctx = ContextOf(
            shown, shownColumns, winner, release, resolveFormKey, loadOrderFormIds,
            shadowed: shown.Where(r => r.IsPartialForm).Select(Column).ToHashSet(StringComparer.Ordinal),
            cellStates: (values, same) => ConflictRules.ComputeCellStates(values, columns[0], OrderOf(conflictingRecords, columns), same),
            comparedCount: conflictingRecords.Count);
        var diffs = RecordChildren(shown, ctx);

        if (conflictingRecords.Count == 1)
            return new ClassifyResult(
                ConflictAll.OnlyOne,
                new Dictionary<string, ConflictThis> { [ctx.MasterColumn] = ConflictThis.OnlyOne },
                diffs);

        var conflictAll = ConflictRules.Reduce(diffs.SelectMany(d => d.CellStates.Values));

        // Keyed by the compound column identity (ADR-0012); ToDictionary would throw on
        // a literal duplicate key.
        var pluginConflictThis = new Dictionary<string, ConflictThis>();
        foreach (var o in conflictingRecords)
        {
            if (ConflictRules.AggregateThis(Column(o), ctx.MasterColumn, diffs.Select(d => d.CellStates)) is { } state)
                pluginConflictThis[Column(o)] = state;
        }

        return new ClassifyResult(conflictAll, pluginConflictThis, diffs);
    }

    // The rows of copies that are no conflict of one another, one column named for each, with no
    // state on any cell or row.
    public IReadOnlyList<FieldDiff> Align(
        IReadOnlyList<RecordDetail> copies,
        IReadOnlyList<string> columns,
        GameRelease release,
        Func<string, RecordLookupEntry?> resolveFormKey,
        Func<string, uint?> loadOrderFormIds) =>
        RecordChildren(copies, ContextOf(
            copies, columns, 0, release, resolveFormKey, loadOrderFormIds,
            shadowed: new HashSet<string>(), cellStates: (_, _) => new Dictionary<string, ConflictThis>()));

    private static IReadOnlyList<(string Column, int LoadOrderIndex)> OrderOf(
        IReadOnlyList<RecordDetail> records, IReadOnlyList<string> columns) =>
        [.. records.Select((r, i) => (columns[i], r.LoadOrderIndex))];

    private DiffContext ContextOf(
        IReadOnlyList<RecordDetail> records, IReadOnlyList<string> columns, int winner, GameRelease release,
        Func<string, RecordLookupEntry?> resolveFormKey, Func<string, uint?> loadOrderFormIds,
        IReadOnlySet<string> shadowed, CellStatesOf cellStates, int? comparedCount = null) =>
        new(
            MasterColumn: columns[0],
            RecordWinnerColumn: columns[winner],
            Columns: columns,
            ColumnOrder: OrderOf(records, columns),
            ComparedOrder: OrderOf([.. records.Take(comparedCount ?? records.Count)], columns),
            PartialFormColumns: records.Select((r, i) => (r, i)).Where(t => t.r.IsPartialForm).Select(t => columns[t.i]).ToHashSet(StringComparer.Ordinal),
            ShadowedColumns: shadowed,
            StatesOf: cellStates,
            FormKey: records[0].FormKey,
            Logger: logger,
            ResolveFormKey: resolveFormKey,
            LoadOrderFormIds: loadOrderFormIds,
            Release: release);

    private static string Column(RecordDetail record) => ColumnKey.Of(record.Plugin, record.Origin);

    private const int MaxArrayChildCount = 500;

    // MasterColumn (ADR-0012) is the compound ColumnKey.Of identity, so no plain-plugin comparison
    // can match the wrong column.
    private sealed record DiffContext(
        string MasterColumn,
        string RecordWinnerColumn,
        IReadOnlyList<string> Columns,
        IReadOnlyList<(string Column, int LoadOrderIndex)> ColumnOrder,
        IReadOnlyList<(string Column, int LoadOrderIndex)> ComparedOrder,
        IReadOnlySet<string> PartialFormColumns,
        IReadOnlySet<string> ShadowedColumns,
        CellStatesOf StatesOf,
        string FormKey,
        ILogger Logger,
        Func<string, RecordLookupEntry?> ResolveFormKey,
        Func<string, uint?> LoadOrderFormIds,
        GameRelease Release);

    // How a node's cells take their conflict state: ComputeCellStates, or none for copies that are
    // no conflict of one another.
    private delegate IReadOnlyDictionary<string, ConflictThis> CellStatesOf(
        Dictionary<string, object?> values, Func<object?, object?, bool> same);

    // One node of the diff tree, at whatever depth the walk reached it. absentMeansDefault is false
    // for an array element, which the codec never omits for equalling its default.
    private static FieldDiff DiffNode(
        string label,
        Dictionary<string, object?> values,
        Dictionary<string, FieldMetadata> shapes,
        bool absentMeansDefault,
        DiffContext ctx,
        bool ignoredInConflicts = false)
    {
        var carrying = ctx.ComparedOrder.Where(c => values.GetValueOrDefault(c.Column) != null).ToList();
        var winnerColumn = carrying.Count > 0 ? carrying.MaxBy(c => c.LoadOrderIndex).Column : ctx.RecordWinnerColumn;
        var shape = shapes[winnerColumn];

        var cellStates = ignoredInConflicts
            ? new Dictionary<string, ConflictThis>()
            : ctx.StatesOf(values, (a, b) => DocumentNodes.SameNode(a, b, shape, absentMeansDefault));

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
        var columns = ctx.Columns;
        var recordClass = records.Select((r, i) => (Column: columns[i], Class: FormReferences.ExtractString(MemberValue(r, LoquiUnions.UnionTypeDiscriminator))))
            .ToDictionary(t => t.Column, t => t.Class);
        var membersOf = records.Select((r, i) => (Column: columns[i], Members: r.Fields.ToDictionary(f => f.Metadata.Name, f => f.Metadata)))
            .ToDictionary(t => t.Column, t => t.Members);
        var diffs = new List<FieldDiff>();
        foreach (var member in records.SelectMany(r => r.Fields).Select(f => f.Metadata).DistinctBy(m => m.Name))
        {
            // A Partial Form override's own fields are excluded as if null (ADR-0018), so they fall
            // through to the previous non-partial override; its header and EditorID take part.
            var header = member.IsRecordHeaderMember;
            var ownField = !header && !member.IsEditorId;
            var values = records.Select((r, i) => (Column: columns[i], Value: ctx.ShadowedColumns.Contains(columns[i]) && ownField ? null : MemberValue(r, member.Name)))
                .ToDictionary(t => t.Column, t => t.Value);
            if (!header && values.Values.All(v => v == null)) continue;
            var shapes = recordClass.ToDictionary(
                kv => kv.Key, kv => DocumentNodes.Variant(membersOf[kv.Key].GetValueOrDefault(member.Name, member), kv.Value));
            diffs.Add(DiffNode(member.Name, values, shapes, absentMeansDefault: true, ctx, member.IgnoredInConflicts));
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

    private sealed record ElementRow(string Label, Dictionary<string, (JsonElement Element, int Index)> Held);

    // An element one plugin lacks is an absence where it is missing, never a shift of the rest.
    private static List<FieldDiff>? ArrayChildren(
        FieldMetadata array, FieldMetadata element, string label, Dictionary<string, object?> values, DiffContext ctx)
    {
        var columns = new List<(string Column, List<JsonElement> Elements)>();
        foreach (var (column, _) in ctx.ColumnOrder)
        {
            if (values.GetValueOrDefault(column) is JsonElement { ValueKind: JsonValueKind.Array } elements)
                columns.Add((column, [.. elements.EnumerateArray()]));
        }

        List<ElementRow>? rows = null;
        if (columns.TrueForAll(c => c.Elements.Count <= MaxArrayChildCount))
            rows = array.KeyMembers is { } keyMembers ? KeyedRows(array, keyMembers, element, columns, ctx.LoadOrderFormIds) : SequenceRows(element, columns);
        if (rows == null || rows.Count > MaxArrayChildCount)
        {
            ctx.Logger.LogWarning(
                "Array field {Field} on {FormKey} has more than MaxArrayChildCount ({Max}) elements across plugins, falling back to opaque display",
                label, ctx.FormKey, MaxArrayChildCount);
            return null;
        }
        if (rows.Count == 0) return null;

        var shapes = values.Keys.ToDictionary(column => column, _ => element);
        return [.. rows.Select(row => DiffNode(
            row.Label,
            values.Keys.ToDictionary(column => column, column => row.Held.TryGetValue(column, out var held) ? (object?)held.Element : null),
            shapes, absentMeansDefault: false, ctx) with
        {
            Indexes = row.Held.ToDictionary(held => held.Key, held => held.Value.Index),
        })];
    }

    private static List<ElementRow> KeyedRows(
        FieldMetadata array, IReadOnlyList<string> keyMembers, FieldMetadata element,
        List<(string Column, List<JsonElement> Elements)> columns, Func<string, uint?>? loadOrderFormIds)
    {
        // Elements sharing a key each take a row, the nth at a key in extended-key order aligning
        // with the nth in every other column, as xEdit's TfrmMain.InitChildren counts them.
        var rows = new Dictionary<(string Key, int Turn), (ElementKey Key, int Turn, Dictionary<string, (JsonElement, int)> Held)>();
        foreach (var (column, elements) in columns)
        {
            var turns = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var index in Enumerable.Range(0, elements.Count).OrderBy(i => ElementKey.SortKeyOf(elements[i], array, loadOrderFormIds), ElementKey.Order))
            {
                var key = ElementKey.Of(elements[index], keyMembers, element, loadOrderFormIds);
                var turn = turns[key.Text] = turns.GetValueOrDefault(key.Text) + 1;
                if (!rows.TryGetValue((key.Text, turn), out var row)) rows[(key.Text, turn)] = row = (key, turn, []);
                row.Held[column] = (elements[index], index);
            }
        }
        return [.. rows.Values
            .OrderBy(row => row.Key, ElementKey.Order)
            .ThenBy(row => row.Turn)
            .Select(row => new ElementRow(row.Key.Text, row.Held))];
    }

    // xEdit's TfrmMain.InitChildren: each column in load order diffed against the rows before it,
    // with no modified pair, and a row only those rows hold before a row only the column holds.
    private static List<ElementRow> SequenceRows(FieldMetadata element, List<(string Column, List<JsonElement> Elements)> columns)
    {
        var rows = new List<(string Text, Dictionary<string, (JsonElement, int)> Held)>();
        foreach (var (column, elements) in columns)
        {
            var texts = elements.Select(e => DocumentNodes.ComparedText(e, element)).ToList();
            var common = new int[rows.Count + 1, texts.Count + 1];
            for (var r = rows.Count - 1; r >= 0; r--)
            {
                for (var t = texts.Count - 1; t >= 0; t--)
                {
                    common[r, t] = rows[r].Text == texts[t]
                        ? common[r + 1, t + 1] + 1
                        : Math.Max(common[r + 1, t], common[r, t + 1]);
                }
            }

            var merged = new List<(string Text, Dictionary<string, (JsonElement, int)> Held)>(rows.Count + texts.Count);
            var (i, j) = (0, 0);
            while (i < rows.Count || j < texts.Count)
            {
                if (i < rows.Count && j < texts.Count && rows[i].Text == texts[j])
                {
                    rows[i].Held[column] = (elements[j], j);
                    merged.Add(rows[i++]);
                    j++;
                }
                else if (i < rows.Count && (j == texts.Count || common[i + 1, j] >= common[i, j + 1])) merged.Add(rows[i++]);
                else
                {
                    merged.Add((texts[j], new() { [column] = (elements[j], j) }));
                    j++;
                }
            }
            rows = merged;
        }
        return [.. rows.Select((row, index) => new ElementRow($"[{index}]", row.Held))];
    }

    // Resolutions (ADR-0005) are a scalar formKey node's alone, never aggregated up from Children, so
    // a dangling sibling can't hide a live hyperlink beside it. A check error is the node's whole
    // subtree's.
    private static (Dictionary<string, FormKeyResolution>? Resolutions, Dictionary<string, string>? CheckErrors) LinkFacts(
        Dictionary<string, FieldMetadata> shapes, Dictionary<string, object?> values, DiffContext ctx)
    {
        var resolve = RecordLookupEntry.Resolver(ctx.ResolveFormKey);

        var resolutions = new Dictionary<string, FormKeyResolution>();
        var checkErrors = new Dictionary<string, string>();
        foreach (var (column, value) in values)
        {
            // A Partial Form override asserts nothing about the fields it omits (ADR-0018), so its
            // absent value is not an unset link to report.
            if (ctx.PartialFormColumns.Contains(column)) continue;
            var meta = shapes[column];
            if (CheckErrorBuilder.Build(meta, value as JsonElement?, resolve, ctx.Release) is { } error)
                checkErrors[column] = error;
            if (meta.Type != "formKey") continue;
            var fk = FormReferences.ExtractString(value);
            if (string.IsNullOrEmpty(fk) || fk == "Null") continue;
            resolutions[column] = FormKeyResolution.From(fk, resolve(fk), meta.ValidFormKeyTypes, ctx.Release);
        }
        return (resolutions.Count > 0 ? resolutions : null, checkErrors.Count > 0 ? checkErrors : null);
    }

    private static object? MemberValue(RecordDetail record, string member) =>
        record.Fields.FirstOrDefault(f => f.Metadata.Name == member)?.Value;

    private static JsonElement? MemberValue(object? owner, string member) =>
        owner is JsonElement { ValueKind: JsonValueKind.Object } obj
        && obj.TryGetProperty(member, out var sub)
        && sub.ValueKind != JsonValueKind.Null
            ? sub
            : null;
}
