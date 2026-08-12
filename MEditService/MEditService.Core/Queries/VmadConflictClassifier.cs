using MEditService.Core.Records;

namespace MEditService.Core.Queries;

// Per-plugin VMAD tree for one record, ordered by load order (master = first). Origin defaulted
// (#272 / ADR-0036) so pre-existing single-origin call sites keep compiling.
public sealed record VmadPluginInput(string Plugin, int LoadOrderIndex, VmadData? Vmad, string Origin = Session.PluginOrigin.DataDirectory);

public sealed record VmadClassifyResult(VmadCompare Compare, ConflictAll ConflictContribution);

// Aligns VMAD across plugins into a FieldDiff-shaped diff and classifies per-cell conflicts,
// mirroring ConflictClassifier semantics (master omitted from CellStates; winner = highest
// load-order plugin that has the cell).
public static class VmadConflictClassifier
{
    // Bundles the per-Classify-call context (all plugin inputs, master plugin, the shared conflict
    // accumulator, and the ADR-0031 resolver) that every recursive Build*/ChildDiff step needs —
    // mirrors ConflictClassifier.DiffContext so the two classifiers stay consistent within this PR.
    private sealed record VmadDiffContext(
        IReadOnlyList<VmadPluginInput> Inputs,
        string MasterColumn,
        ConflictAccumulator Conflict,
        Func<string, RecordLookupEntry?>? ResolveFormKey);

    // resolveFormKey: ADR-0031's O(1) lookup, batched once per Classify call. VMAD's Object-kind
    // properties reference ordinary major records (not VMAD-internal data), so they resolve through
    // the same lookup as FieldDiff — no VMAD-specific index or expected-type list exists at this
    // layer, so every resolved Object is either ResolvedValidType or Unresolved, never
    // ResolvedWrongType (there's no Papyrus-declared expected record type to compare against).
    // pluginParticipates (#267 / ADR-0035): the plugins.txt `*` prefix, keyed by plugin name. A
    // non-participating plugin's VMAD is excluded before any diff/winner/cell-state computation —
    // mirrors ConflictClassifier.Classify's identical filter. Null (the default) means every plugin
    // in inputs participates, preserving prior behavior for existing callers.
    public static VmadClassifyResult Classify(
        IReadOnlyList<VmadPluginInput> inputs,
        Func<string, RecordLookupEntry?>? resolveFormKey = null,
        IReadOnlyDictionary<string, bool>? pluginParticipates = null)
    {
        if (pluginParticipates != null)
            inputs = [.. inputs.Where(i => pluginParticipates.GetValueOrDefault(i.Plugin, true))];

        var present = inputs.Where(i => i.Vmad != null).ToList();
        if (present.Count == 0)
            return new VmadClassifyResult(new VmadCompare([]), ConflictAll.NoConflict);

        var masterColumn = ColumnKey.Of(inputs[0].Plugin, inputs[0].Origin);
        var conflict = new ConflictAccumulator();
        var ctx = new VmadDiffContext(inputs, masterColumn, conflict, resolveFormKey);

        var scriptNames = present
            .SelectMany(i => i.Vmad!.Scripts.Select(s => s.Name))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();

        var scriptDiffs = scriptNames
            .ConvertAll(scriptName =>
            {
                // #272 / ADR-0036: keyed by the compound column identity — two inputs sharing a
                // filename but differing in origin must land as two independent entries, not collide.
                var perPlugin = inputs.ToDictionary(
                    i => ColumnKey.Of(i.Plugin, i.Origin),
                    i => i.Vmad?.Scripts.FirstOrDefault(s => s.Name == scriptName));

                var flags = perPlugin.ToDictionary(kv => kv.Key, kv => kv.Value?.Flags);
                var (cellStates, winner) = ComputeCellStates(inputs, masterColumn, p => perPlugin[p]?.Flags);
                conflict.Add(cellStates);

                var properties = BuildPropertyDiffs(perPlugin, ctx);
                return new VmadScriptDiff(scriptName, flags, winner, cellStates, properties);
            });

        return new VmadClassifyResult(new VmadCompare(scriptDiffs), conflict.Result);
    }

    private static List<VmadPropertyDiff> BuildPropertyDiffs(
        Dictionary<string, VmadScriptData?> perPluginScript, VmadDiffContext ctx)
    {
        var propNames = ctx.Inputs
            .Select(i => perPluginScript[ColumnKey.Of(i.Plugin, i.Origin)])
            .Where(s => s != null)
            .SelectMany(s => s!.Properties.Select(p => p.Name))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();

        return [.. propNames
            .Select(propName =>
            {
                var perPlugin = ctx.Inputs.ToDictionary(
                    i => ColumnKey.Of(i.Plugin, i.Origin),
                    i => perPluginScript[ColumnKey.Of(i.Plugin, i.Origin)]?.Properties.FirstOrDefault(p => p.Name == propName)?.Value);
                return BuildDiff(propName, perPlugin, ctx);
            })];
    }

    private static VmadPropertyDiff BuildDiff(
        string name, Dictionary<string, VmadPropertyValue?> perPlugin, VmadDiffContext ctx)
    {
        var kind = Kind(perPlugin.Values.First(v => v != null)!.Type);
        var types = perPlugin
            .Where(kv => kv.Value != null)
            .ToDictionary(kv => kv.Key, kv => kv.Value!.Type);
        var values = perPlugin.ToDictionary(kv => kv.Key, kv => LeafValue(kv.Value));

        var (cellStates, winner) = ComputeCellStates(ctx.Inputs, ctx.MasterColumn, p => Canon(perPlugin[p]));
        ctx.Conflict.Add(cellStates);

        var children = BuildChildren(kind, perPlugin, ctx);
        var raw = BuildRaw(kind, perPlugin);
        var resolutions = BuildResolutions(kind, perPlugin, ctx.ResolveFormKey);
        return new VmadPropertyDiff(name, kind, values, types, winner, cellStates, children, raw, resolutions);
    }

    // Only an "object"-kind leaf carries Resolutions — never aggregated from Children, so a
    // dangling Object in one array element/struct member doesn't hide a live link on its siblings
    // (ADR-0031, same independence fix as FieldDiff).
    private static Dictionary<string, FormKeyResolution>? BuildResolutions(
        string kind,
        Dictionary<string, VmadPropertyValue?> perPlugin,
        Func<string, RecordLookupEntry?>? resolveFormKey)
    {
        if (resolveFormKey == null || kind != "object") return null;

        var resolutions = new Dictionary<string, FormKeyResolution>();
        foreach (var (plugin, value) in perPlugin)
        {
            if (value?.Value is not string fk || fk.Length == 0) continue;
            resolutions[plugin] = FormKeyResolution.From(resolveFormKey(fk), []);
        }
        return resolutions.Count > 0 ? resolutions : null;
    }

    // Per-plugin editable subtree for struct/structList in the VmadPropertyNode shape the apply
    // path consumes — frontend patches one member by path and restages the whole value.
    private static Dictionary<string, object?>? BuildRaw(
        string kind, Dictionary<string, VmadPropertyValue?> perPlugin) => kind switch
        {
            "struct" => perPlugin
                .Where(kv => kv.Value?.Members != null)
                .ToDictionary(kv => kv.Key, kv => (object?)ToNodes(kv.Value!.Members!)),
            "structList" => perPlugin
                .Where(kv => kv.Value?.StructList != null)
                .ToDictionary(kv => kv.Key, kv => (object?)kv.Value!.StructList!
                    .Select(inst => (IReadOnlyList<Schema.VmadPropertyNode>)ToNodes(inst))
                    .ToList()),
            _ => null,
        };

    private static Schema.VmadPropertyNode[] ToNodes(IReadOnlyList<VmadNamedValue> members) =>
        [.. members.Select(m => ToNode(m.Name, m.Value))];

    private static Schema.VmadPropertyNode ToNode(string name, VmadPropertyValue v) => v.Type switch
    {
        "Bool" => new(name, "Bool", v.Flags, BoolValue: v.Value as bool?),
        "Int" => new(name, "Int", v.Flags, IntValue: v.Value as int?),
        "Float" => new(name, "Float", v.Flags, FloatValue: v.Value as float?),
        "String" => new(name, "String", v.Flags, StringValue: v.Value as string),
        "Object" => new(name, "Object", v.Flags, FormKeyValue: v.Value as string, AliasValue: v.Alias),
        "Struct" => new(name, "Struct", v.Flags,
            Members: v.Members is null ? null : ToNodes(v.Members)),
        _ => new(name, v.Type, v.Flags),
    };

    private static List<VmadPropertyDiff>? BuildChildren(
        string kind, Dictionary<string, VmadPropertyValue?> perPlugin, VmadDiffContext ctx) => kind switch
        {
            "array" => IndexedChildren(perPlugin, ctx, v => v.ListItems, (sl, idx) => sl[idx]),
            "struct" => MemberChildren(perPlugin, ctx),
            "structList" => IndexedChildren(perPlugin, ctx,
                v => v.StructList, (sl, idx) => new VmadPropertyValue("Struct", "", null, Members: sl[idx])),
            _ => null,
        };

    // Aligns array/struct-list elements by index. Each plugin contributes element idx if present.
    private static List<VmadPropertyDiff>? IndexedChildren<T>(
        Dictionary<string, VmadPropertyValue?> perPlugin,
        VmadDiffContext ctx,
        Func<VmadPropertyValue, IReadOnlyList<T>?> select,
        Func<IReadOnlyList<T>, int, VmadPropertyValue> elementAt)
    {
        var maxLen = perPlugin.Values.Select(v => v is null ? 0 : select(v)?.Count ?? 0).DefaultIfEmpty(0).Max();
        return maxLen == 0
            ? null
            : ([.. Enumerable.Range(0, maxLen)
            .Select(idx => ChildDiff($"[{idx}]", perPlugin, ctx,
                v => select(v) is { } list && idx < list.Count ? elementAt(list, idx) : null))]);
    }

    // Aligns struct members by name (union, sorted).
    private static List<VmadPropertyDiff>? MemberChildren(
        Dictionary<string, VmadPropertyValue?> perPlugin, VmadDiffContext ctx)
    {
        var names = perPlugin.Values
            .Where(v => v?.Members != null)
            .SelectMany(v => v!.Members!)
            .Select(m => m.Name)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        return names.Count == 0
            ? null
            : ([.. names
            .Select(mn => ChildDiff(mn, perPlugin, ctx,
                v => v.Members?.FirstOrDefault(m => m.Name == mn)?.Value))]);
    }

    private static VmadPropertyDiff ChildDiff(
        string name,
        Dictionary<string, VmadPropertyValue?> perPlugin,
        VmadDiffContext ctx,
        Func<VmadPropertyValue, VmadPropertyValue?> pick)
    {
        var childPer = perPlugin.ToDictionary(kv => kv.Key, kv => kv.Value is null ? null : pick(kv.Value));
        return BuildDiff(name, childPer, ctx);
    }

    // Delegates per-cell classification to ConflictRules (shared with the generic field path):
    // master omitted; winner = highest load-order plugin with a non-null value. Callers only ever
    // align names drawn from the union of plugins that have the value, so at least one canonical
    // value is always non-null and a winner exists.
    private static (Dictionary<string, ConflictThis> States, string Winner) ComputeCellStates(
        IReadOnlyList<VmadPluginInput> inputs, string masterColumn, Func<string, string?> valueOf)
    {
        // Materialize each plugin's canonical value once — valueOf can recurse through a struct
        // subtree. Keyed by the compound column identity (#272 / ADR-0036), matching perPlugin.
        var canon = inputs.ToDictionary(i => ColumnKey.Of(i.Plugin, i.Origin), i => (object?)valueOf(ColumnKey.Of(i.Plugin, i.Origin)));
        var columnOrder = inputs.Select(i => (ColumnKey.Of(i.Plugin, i.Origin), i.LoadOrderIndex)).ToList();

        var winner = ConflictRules.PickWinner(columnOrder, p => canon[p] != null);

        var states = ConflictRules.ComputeCellStates(canon, masterColumn, columnOrder, Equals);

        return (states, winner);
    }

    private static string Kind(string? type) => type switch
    {
        null => "scalar",
        "Object" => "object",
        "Struct" => "struct",
        "ArrayOfStruct" => "structList",
        "Variable" or "ArrayOfVariable" => "variable",
        _ when type.StartsWith("ArrayOf", StringComparison.Ordinal) => "array",
        _ => "scalar",
    };

    private static object? LeafValue(VmadPropertyValue? v)
    {
        if (v == null) return null;
        if (v.Type == "Object") return ObjectLeaf(v);
        return v.Value; // null for Struct/ArrayOf* — their data lives in Members/ListItems/StructList
    }

    // Single source of truth for the Object-type null-guard: null when unset, else "Value [Alias]".
    private static string? ObjectLeaf(VmadPropertyValue v) => v.Value == null ? null : $"{v.Value} [{v.Alias}]";

    // Canonical comparison string for a property value (null = absent). Prefixed with Type so a
    // property whose Type differs across plugins registers as a conflict, not just a value change.
    // Recurses into containers so a difference anywhere in the subtree flags the parent cell.
    internal static string? Canon(VmadPropertyValue? v)
    {
        if (v == null) return null;
        if (v.Members != null)
        {
            return "Struct{" + string.Join(",", v.Members
                .OrderBy(m => m.Name, StringComparer.Ordinal)
                .Select(m => $"{m.Name}={Canon(m.Value)}")) + "}";
        }

        if (v.StructList != null)
        {
            return "ArrayOfStruct[" + string.Join(",", v.StructList
                .Select(inst => "{" + string.Join(",", inst
                    .OrderBy(m => m.Name, StringComparer.Ordinal)
                    .Select(m => $"{m.Name}={Canon(m.Value)}")) + "}")) + "]";
        }

        if (v.ListItems != null)
            return $"{v.Type}[" + string.Join(",", v.ListItems.Select(Canon)) + "]";

        var leaf = v.Type == "Object"
            ? ObjectLeaf(v) ?? ""
            : v.Value?.ToString() ?? "";
        return $"{v.Type}|{leaf}";
    }

    // Collects per-cell states across the whole VMAD tree and folds them via ConflictRules.Reduce
    // (shared with the generic field path) into a single record-level conflict contribution.
    private sealed class ConflictAccumulator
    {
        private readonly List<ConflictThis> _states = [];

        public void Add(IReadOnlyDictionary<string, ConflictThis> states) => _states.AddRange(states.Values);

        public ConflictAll Result => ConflictRules.Reduce(_states);
    }
}
