using MEditService.Core.Records;
using MEditService.Core.Schema;

namespace MEditService.Core.Queries;

// Per-plugin conditions for one record, ordered by load order (master = first). Origin defaulted
// (#272 / ADR-0036) so pre-existing single-origin call sites keep compiling.
public sealed record ConditionPluginInput(
    string Plugin, int LoadOrderIndex, IReadOnlyList<ConditionOwner> Owners, string Origin = Session.PluginOrigin.DataDirectory);

public sealed record ConditionClassifyResult(ConditionCompare Compare, ConflictAll ConflictContribution);

// Aligns a record's conditions across plugins (by field path, then by index within the field) and
// classifies each row's per-cell conflict with the same two-axis rules as ordinary fields and VMAD
// (ADR-0016). Conditions are a flat ordered list, so alignment is positional — mirroring VMAD's
// array-element alignment without its struct/nesting machinery. [ADR-0032]
public static class ConditionConflictClassifier
{
    // resolveFormKey: ADR-0031's O(1) lookup, batched once per Classify call (mirrors
    // VmadConflictClassifier's identical parameter) — #166 closes the gap where GetCompare built
    // this resolver but never threaded it into the condition path at all.
    // pluginParticipates (#267 / ADR-0035): the plugins.txt `*` prefix, keyed by plugin name. A
    // non-participating plugin's conditions are excluded before any diff/winner/cell-state
    // computation — mirrors ConflictClassifier.Classify's identical filter. Null (the default)
    // means every plugin in inputs participates, preserving prior behavior for existing callers.
    public static ConditionClassifyResult Classify(
        IReadOnlyList<ConditionPluginInput> inputs,
        Func<string, RecordLookupEntry?>? resolveFormKey = null,
        IReadOnlyDictionary<string, bool>? pluginParticipates = null)
    {
        if (pluginParticipates != null)
            inputs = [.. inputs.Where(i => pluginParticipates.GetValueOrDefault(i.Plugin, true))];

        var present = inputs.Where(i => i.Owners.Count > 0).ToList();
        if (present.Count == 0)
            return new ConditionClassifyResult(new ConditionCompare([]), ConflictAll.NoConflict);

        // #272 / ADR-0036: keyed by the compound column identity — two inputs sharing a filename but
        // differing in origin must land as two independent entries, not collide.
        var masterColumn = ColumnKey.Of(inputs[0].Plugin, inputs[0].Origin);
        var columnOrder = inputs.Select(i => (ColumnKey.Of(i.Plugin, i.Origin), i.LoadOrderIndex)).ToList();
        var allStates = new List<ConflictThis>();

        var fieldPaths = present
            .SelectMany(i => i.Owners.Select(o => o.FieldPath))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(p => p, NaturalFieldPathComparer.Instance)
            .ToList();

        var groups = fieldPaths.ConvertAll(fieldPath =>
        {
            var perPluginConditions = inputs.ToDictionary(
                i => ColumnKey.Of(i.Plugin, i.Origin),
                i => i.Owners.FirstOrDefault(o => o.FieldPath == fieldPath)?.Conditions ?? []);

            var maxLen = perPluginConditions.Values.Select(c => c.Count).DefaultIfEmpty(0).Max();

            var diffs = Enumerable.Range(0, maxLen)
                .Select(idx => BuildDiff(idx, inputs, perPluginConditions, masterColumn, columnOrder, allStates, resolveFormKey))
                .ToList();

            return new ConditionGroupDiff(fieldPath, diffs);
        });

        return new ConditionClassifyResult(new ConditionCompare(groups), ConflictRules.Reduce(allStates));
    }

    private static ConditionDiff BuildDiff(
        int idx,
        IReadOnlyList<ConditionPluginInput> inputs,
        Dictionary<string, IReadOnlyList<ParsedCondition>> perPluginConditions,
        string masterColumn,
        IReadOnlyList<(string Plugin, int LoadOrderIndex)> columnOrder,
        List<ConflictThis> allStates,
        Func<string, RecordLookupEntry?>? resolveFormKey)
    {
        var perPlugin = inputs.ToDictionary(
            i => ColumnKey.Of(i.Plugin, i.Origin),
            i =>
            {
                var column = ColumnKey.Of(i.Plugin, i.Origin);
                return idx < perPluginConditions[column].Count ? perPluginConditions[column][idx] : null;
            });

        var canon = perPlugin.ToDictionary(kv => kv.Key, kv => (object?)Canon(kv.Value));
        var cellStates = ConflictRules.ComputeCellStates(canon, masterColumn, columnOrder, Equals);
        allStates.AddRange(cellStates.Values);

        var winner = ConflictRules.PickWinner(columnOrder, p => perPlugin[p] != null);
        var fieldCellStates = FieldCellStates(perPlugin, masterColumn, columnOrder);
        var fieldResolutions = FieldResolutions(perPlugin, resolveFormKey);

        return new ConditionDiff(idx, perPlugin, winner, cellStates, fieldCellStates, fieldResolutions);
    }

    // Per-field two-axis states so the expanded view colors each field independently — the same
    // model as ordinary fields / VMAD property rows (only a field that actually differs is flagged,
    // not every field because the condition as a whole differs). Keyed by a stable field id shared
    // with the frontend; parameters key as "param:{i}". Not folded into the record-level ConflictAll
    // (that stays the whole-condition signal via `cellStates`).
    private static Dictionary<string, IReadOnlyDictionary<string, ConflictThis>> FieldCellStates(
        Dictionary<string, ParsedCondition?> perPlugin,
        string masterPlugin,
        IReadOnlyList<(string Plugin, int LoadOrderIndex)> pluginOrder)
    {
        var states = new Dictionary<string, IReadOnlyDictionary<string, ConflictThis>>();

        void Field(string key, Func<ParsedCondition, string?> project)
        {
            var values = perPlugin.ToDictionary(
                kv => kv.Key, kv => (object?)(kv.Value == null ? null : project(kv.Value) ?? ""));
            states[key] = ConflictRules.ComputeCellStates(values, masterPlugin, pluginOrder, Equals);
        }

        Field("function", c => c.Function);
        Field("operator", c => c.Operator.ToString());
        Field("gate", c => c.Or.ToString());
        Field("runOn", c => $"{c.RunOnTarget}|{c.RunOnReference}");
        Field("comparison", c => c.UseGlobal ? $"G:{c.ComparisonGlobal}" : $"F:{c.ComparisonFloat}");

        var maxParams = perPlugin.Values.Where(c => c != null).Select(c => c!.Parameters.Count).DefaultIfEmpty(0).Max();
        for (var i = 0; i < maxParams; i++)
        {
            var index = i;
            Field($"param:{index}", c => index < c.Parameters.Count ? CanonParam(c.Parameters[index]) : null);
        }

        return states;
    }

    // FormKey→EditorID resolution (#166, ADR-0031) for a condition's three FormKey-bearing slots,
    // keyed the same way FieldCellStates already keys its per-field states — "runOn" (only when
    // RunOnTarget == Reference), "comparison" (only when UseGlobal), "param:{i}" for each
    // Form-category parameter. null when no resolver was passed, mirroring
    // VmadConflictClassifier.BuildResolutions' identical resolver-absent short-circuit.
    private static Dictionary<string, IReadOnlyDictionary<string, FormKeyResolution>>? FieldResolutions(
        Dictionary<string, ParsedCondition?> perPlugin, Func<string, RecordLookupEntry?>? resolveFormKey)
    {
        if (resolveFormKey == null) return null;

        var resolutions = new Dictionary<string, IReadOnlyDictionary<string, FormKeyResolution>>();

        void Field(string key, Func<ParsedCondition, string?> extractFormKey, IReadOnlyList<string> validTypes)
        {
            var perPluginResolution = perPlugin
                .Where(kv => kv.Value != null && extractFormKey(kv.Value) is { Length: > 0 })
                .ToDictionary(kv => kv.Key, kv => FormKeyResolution.From(resolveFormKey(extractFormKey(kv.Value!)!), validTypes));
            if (perPluginResolution.Count > 0) resolutions[key] = perPluginResolution;
        }

        // RunOnReference / a Form parameter's FormKey have no known expected record type (no
        // Mutagen-side function-parameter-type→record-type table exists), matching VMAD Object
        // properties' own `[]`. ComparisonGlobal always expects a GLOB, matching the frontend's own
        // hardcoded formKeyMeta(['glob']) for this field (ConditionCells.tsx) — passing it through
        // here costs nothing and buys ResolvedWrongType detection for free.
        Field("runOn", c => c.RunOnTarget == "Reference" ? c.RunOnReference : null, []);
        Field("comparison", c => c.UseGlobal ? c.ComparisonGlobal : null, ["glob"]);

        var maxParams = perPlugin.Values.Where(c => c != null).Select(c => c!.Parameters.Count).DefaultIfEmpty(0).Max();
        for (var i = 0; i < maxParams; i++)
        {
            var index = i;
            Field($"param:{index}",
                c => index < c.Parameters.Count && c.Parameters[index].Category == ConditionParamCategory.Form
                    ? c.Parameters[index].FormKey
                    : null,
                []);
        }

        return resolutions.Count > 0 ? resolutions : null;
    }

    private static string CanonParam(ParsedConditionParam p) =>
        $"{p.Category}:{p.TypeName}:{p.Number}:{p.FormKey}:{p.Text}";

    // Stable canonical string over every displayed field, so a difference anywhere in the condition
    // (function, operator, gate, run-on, comparison, or any parameter) flags the cell as a conflict.
    private static string? Canon(ParsedCondition? c)
    {
        if (c == null) return null;
        var parameters = string.Join(";", c.Parameters.Select(CanonParam));
        return string.Join("|",
            c.Function, c.Operator, c.Or, c.RunOnTarget, c.RunOnReference,
            c.UseGlobal, c.ComparisonFloat, c.ComparisonGlobal, parameters);
    }

    // Orders field paths so a nested group's embedded array index sorts numerically rather than
    // character-by-character (#181) — a flat path like "Conditions" has no digit run and sorts by
    // plain ordinal comparison same as before; a nested path like "Effects[2].Conditions" must sort
    // before "Effects[10].Conditions", which plain StringComparer.Ordinal gets backwards (the
    // character '1' < '2'). Splits each path into alternating digit/non-digit runs and compares
    // digit runs as integers, non-digit runs ordinally — the general "natural sort" algorithm, not a
    // condition-path-specific hack, so it also does the right thing for any future field-path shape
    // that embeds a number.
    private sealed class NaturalFieldPathComparer : IComparer<string>
    {
        public static readonly NaturalFieldPathComparer Instance = new();

        public int Compare(string? x, string? y)
        {
            if (x == null || y == null) return string.CompareOrdinal(x, y);

            var xRuns = SplitRuns(x);
            var yRuns = SplitRuns(y);
            var count = Math.Min(xRuns.Count, yRuns.Count);

            for (var i = 0; i < count; i++)
            {
                var cmp = CompareRun(xRuns[i], yRuns[i]);
                if (cmp != 0) return cmp;
            }

            return xRuns.Count.CompareTo(yRuns.Count);
        }

        private static int CompareRun(string a, string b)
        {
            var aIsDigits = a.Length > 0 && char.IsDigit(a[0]);
            var bIsDigits = b.Length > 0 && char.IsDigit(b[0]);
            if (aIsDigits && bIsDigits && long.TryParse(a, out var an) && long.TryParse(b, out var bn))
                return an.CompareTo(bn);
            return string.CompareOrdinal(a, b);
        }

        private static List<string> SplitRuns(string s)
        {
            var runs = new List<string>();
            var start = 0;
            while (start < s.Length)
            {
                var isDigit = char.IsDigit(s[start]);
                var end = start + 1;
                while (end < s.Length && char.IsDigit(s[end]) == isDigit) end++;
                runs.Add(s[start..end]);
                start = end;
            }
            return runs;
        }
    }
}
