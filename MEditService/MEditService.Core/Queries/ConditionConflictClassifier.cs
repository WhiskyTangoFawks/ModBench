using MEditService.Core.Schema;

namespace MEditService.Core.Queries;

// Per-plugin conditions for one record, ordered by load order (master = first).
public sealed record ConditionPluginInput(string Plugin, int LoadOrderIndex, IReadOnlyList<ConditionOwner> Owners);

public sealed record ConditionClassifyResult(ConditionCompare Compare, ConflictAll ConflictContribution);

// Aligns a record's conditions across plugins (by field path, then by index within the field) and
// classifies each row's per-cell conflict with the same two-axis rules as ordinary fields and VMAD
// (ADR-0016). Conditions are a flat ordered list, so alignment is positional — mirroring VMAD's
// array-element alignment without its struct/nesting machinery. [ADR-0032]
public static class ConditionConflictClassifier
{
    public static ConditionClassifyResult Classify(IReadOnlyList<ConditionPluginInput> inputs)
    {
        var present = inputs.Where(i => i.Owners.Count > 0).ToList();
        if (present.Count == 0)
            return new ConditionClassifyResult(new ConditionCompare([]), ConflictAll.NoConflict);

        var masterPlugin = inputs[0].Plugin;
        var pluginOrder = inputs.Select(i => (i.Plugin, i.LoadOrderIndex)).ToList();
        var allStates = new List<ConflictThis>();

        var fieldPaths = present
            .SelectMany(i => i.Owners.Select(o => o.FieldPath))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(p => p, StringComparer.Ordinal)
            .ToList();

        var groups = fieldPaths.ConvertAll(fieldPath =>
        {
            var perPluginConditions = inputs.ToDictionary(
                i => i.Plugin,
                i => i.Owners.FirstOrDefault(o => o.FieldPath == fieldPath)?.Conditions ?? []);

            var maxLen = perPluginConditions.Values.Select(c => c.Count).DefaultIfEmpty(0).Max();

            var diffs = Enumerable.Range(0, maxLen)
                .Select(idx => BuildDiff(idx, inputs, perPluginConditions, masterPlugin, pluginOrder, allStates))
                .ToList();

            return new ConditionGroupDiff(fieldPath, diffs);
        });

        return new ConditionClassifyResult(new ConditionCompare(groups), ConflictRules.Reduce(allStates));
    }

    private static ConditionDiff BuildDiff(
        int idx,
        IReadOnlyList<ConditionPluginInput> inputs,
        Dictionary<string, IReadOnlyList<ParsedCondition>> perPluginConditions,
        string masterPlugin,
        IReadOnlyList<(string Plugin, int LoadOrderIndex)> pluginOrder,
        List<ConflictThis> allStates)
    {
        var perPlugin = inputs.ToDictionary(
            i => i.Plugin,
            i => idx < perPluginConditions[i.Plugin].Count ? perPluginConditions[i.Plugin][idx] : null);

        var canon = perPlugin.ToDictionary(kv => kv.Key, kv => (object?)Canon(kv.Value));
        var cellStates = ConflictRules.ComputeCellStates(canon, masterPlugin, pluginOrder, Equals);
        allStates.AddRange(cellStates.Values);

        var winner = ConflictRules.PickWinner(pluginOrder, p => perPlugin[p] != null);
        var fieldCellStates = FieldCellStates(perPlugin, masterPlugin, pluginOrder);

        return new ConditionDiff(idx, perPlugin, winner, cellStates, fieldCellStates);
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
}
