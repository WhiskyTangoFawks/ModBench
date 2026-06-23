using MEditService.Core.Records;

namespace MEditService.Core.Queries;

// Per-plugin VMAD tree for one record, ordered by load order (master = first).
public sealed record VmadPluginInput(string Plugin, int LoadOrderIndex, VmadData? Vmad);

public sealed record VmadClassifyResult(VmadCompare Compare, ConflictAll ConflictContribution);

// Aligns VMAD across plugins into a FieldDiff-shaped diff and classifies per-cell conflicts,
// mirroring ConflictClassifier semantics (master omitted from CellStates; winner = highest
// load-order plugin that has the cell).
public static class VmadConflictClassifier
{
    public static VmadClassifyResult Classify(IReadOnlyList<VmadPluginInput> inputs)
    {
        var present = inputs.Where(i => i.Vmad != null).ToList();
        if (present.Count == 0)
            return new VmadClassifyResult(new VmadCompare([]), ConflictAll.NoConflict);

        var masterPlugin = inputs[0].Plugin;
        var conflict = new ConflictAccumulator();

        var scriptNames = present
            .SelectMany(i => i.Vmad!.Scripts.Select(s => s.Name))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();

        var scriptDiffs = scriptNames
            .Select(scriptName =>
            {
                var perPlugin = inputs.ToDictionary(
                    i => i.Plugin,
                    i => i.Vmad?.Scripts.FirstOrDefault(s => s.Name == scriptName));

                var flags = perPlugin.ToDictionary(kv => kv.Key, kv => kv.Value?.Flags);
                var (cellStates, winner) = ComputeCellStates(inputs, masterPlugin, p => perPlugin[p]?.Flags);
                conflict.Add(cellStates);

                var properties = BuildPropertyDiffs(inputs, masterPlugin, perPlugin, conflict);
                return new VmadScriptDiff(scriptName, flags, winner, cellStates, properties);
            })
            .ToList();

        return new VmadClassifyResult(new VmadCompare(scriptDiffs), conflict.Result);
    }

    private static List<VmadPropertyDiff> BuildPropertyDiffs(
        IReadOnlyList<VmadPluginInput> inputs,
        string masterPlugin,
        Dictionary<string, VmadScriptData?> perPluginScript,
        ConflictAccumulator conflict)
    {
        var propNames = inputs
            .Select(i => perPluginScript[i.Plugin])
            .Where(s => s != null)
            .SelectMany(s => s!.Properties.Select(p => p.Name))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();

        return propNames
            .Select(propName =>
            {
                var perPlugin = inputs.ToDictionary(
                    i => i.Plugin,
                    i => perPluginScript[i.Plugin]?.Properties.FirstOrDefault(p => p.Name == propName)?.Value);
                return BuildDiff(propName, perPlugin, inputs, masterPlugin, conflict);
            })
            .ToList();
    }

    private static VmadPropertyDiff BuildDiff(
        string name,
        Dictionary<string, VmadPropertyValue?> perPlugin,
        IReadOnlyList<VmadPluginInput> inputs,
        string masterPlugin,
        ConflictAccumulator conflict)
    {
        var kind = Kind(perPlugin.Values.First(v => v != null)!.Type);
        var types = perPlugin
            .Where(kv => kv.Value != null)
            .ToDictionary(kv => kv.Key, kv => kv.Value!.Type);
        var values = perPlugin.ToDictionary(kv => kv.Key, kv => LeafValue(kv.Value));

        var (cellStates, winner) = ComputeCellStates(inputs, masterPlugin, p => Canon(perPlugin[p]));
        conflict.Add(cellStates);

        var children = BuildChildren(kind, perPlugin, inputs, masterPlugin, conflict);
        var raw = BuildRaw(kind, perPlugin);
        return new VmadPropertyDiff(name, kind, values, types, winner, cellStates, children, raw);
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
        members.Select(m => ToNode(m.Name, m.Value)).ToArray();

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
        string kind,
        Dictionary<string, VmadPropertyValue?> perPlugin,
        IReadOnlyList<VmadPluginInput> inputs,
        string masterPlugin,
        ConflictAccumulator conflict) => kind switch
        {
            "array" => IndexedChildren(perPlugin, inputs, masterPlugin, conflict,
                v => v.ListItems, (sl, idx) => sl[idx]),
            "struct" => MemberChildren(perPlugin, inputs, masterPlugin, conflict),
            "structList" => IndexedChildren(perPlugin, inputs, masterPlugin, conflict,
                v => v.StructList, (sl, idx) => new VmadPropertyValue("Struct", "", null, Members: sl[idx])),
            _ => null,
        };

    // Aligns array/struct-list elements by index. Each plugin contributes element idx if present.
    private static List<VmadPropertyDiff>? IndexedChildren<T>(
        Dictionary<string, VmadPropertyValue?> perPlugin,
        IReadOnlyList<VmadPluginInput> inputs,
        string masterPlugin,
        ConflictAccumulator conflict,
        Func<VmadPropertyValue, IReadOnlyList<T>?> select,
        Func<IReadOnlyList<T>, int, VmadPropertyValue> elementAt)
    {
        var maxLen = perPlugin.Values.Select(v => v is null ? 0 : select(v)?.Count ?? 0).DefaultIfEmpty(0).Max();
        if (maxLen == 0) return null;

        return Enumerable.Range(0, maxLen)
            .Select(idx => ChildDiff($"[{idx}]", perPlugin, inputs, masterPlugin, conflict,
                v => select(v) is { } list && idx < list.Count ? elementAt(list, idx) : null))
            .ToList();
    }

    // Aligns struct members by name (union, sorted).
    private static List<VmadPropertyDiff>? MemberChildren(
        Dictionary<string, VmadPropertyValue?> perPlugin,
        IReadOnlyList<VmadPluginInput> inputs,
        string masterPlugin,
        ConflictAccumulator conflict)
    {
        var names = perPlugin.Values
            .Where(v => v?.Members != null)
            .SelectMany(v => v!.Members!)
            .Select(m => m.Name)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        if (names.Count == 0) return null;

        return names
            .Select(mn => ChildDiff(mn, perPlugin, inputs, masterPlugin, conflict,
                v => v.Members?.FirstOrDefault(m => m.Name == mn)?.Value))
            .ToList();
    }

    private static VmadPropertyDiff ChildDiff(
        string name,
        Dictionary<string, VmadPropertyValue?> perPlugin,
        IReadOnlyList<VmadPluginInput> inputs,
        string masterPlugin,
        ConflictAccumulator conflict,
        Func<VmadPropertyValue, VmadPropertyValue?> pick)
    {
        var childPer = perPlugin.ToDictionary(kv => kv.Key, kv => kv.Value is null ? null : pick(kv.Value));
        return BuildDiff(name, childPer, inputs, masterPlugin, conflict);
    }

    // Mirrors ConflictClassifier.ComputeCellStates: master omitted; winner = highest load-order
    // plugin with a non-null value. Callers only ever align names drawn from the union of plugins
    // that have the value, so at least one canonical value is always non-null and a winner exists.
    private static (Dictionary<string, ConflictThis> States, string Winner) ComputeCellStates(
        IReadOnlyList<VmadPluginInput> inputs, string masterPlugin, Func<string, string?> valueOf)
    {
        // Materialize each plugin's canonical value once — valueOf can recurse through a struct subtree.
        var canon = inputs.ToDictionary(i => i.Plugin, i => valueOf(i.Plugin));

        var winner = inputs
            .Where(i => canon[i.Plugin] != null)
            .MaxBy(i => i.LoadOrderIndex)!
            .Plugin;

        var ctx = new CellContext(masterPlugin, winner, canon[masterPlugin], canon[winner], canon);

        var states = inputs
            .Where(i => i.Plugin != masterPlugin)
            .Select(i => (i.Plugin, State: ClassifyCell(i.Plugin, canon[i.Plugin], ctx)))
            .Where(x => x.State.HasValue)
            .ToDictionary(x => x.Plugin, x => x.State!.Value);

        return (states, winner);
    }

    private readonly record struct CellContext(
        string MasterPlugin, string Winner, string? MasterValue, string? WinnerValue,
        IReadOnlyDictionary<string, string?> CanonByPlugin);

    private static ConflictThis? ClassifyCell(string plugin, string? value, CellContext ctx)
    {
        if (value == null) return null;
        if (value == ctx.MasterValue) return ConflictThis.IdenticalToMaster;

        if (plugin == ctx.Winner)
        {
            var contested = ctx.CanonByPlugin.Any(kv =>
                kv.Key != ctx.MasterPlugin && kv.Key != plugin &&
                kv.Value is string rv && rv != value);
            return contested ? ConflictThis.ConflictWins : ConflictThis.Override;
        }

        return value != ctx.WinnerValue ? ConflictThis.ConflictLoses : ConflictThis.Override;
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
        if (v.Type == "Object") return $"{v.Value} [{v.Alias}]";
        return v.Value; // null for Struct/ArrayOf* — their data lives in Members/ListItems/StructList
    }

    // Canonical comparison string for a property value (null = absent). Prefixed with Type so a
    // property whose Type differs across plugins registers as a conflict, not just a value change.
    // Recurses into containers so a difference anywhere in the subtree flags the parent cell.
    internal static string? Canon(VmadPropertyValue? v)
    {
        if (v == null) return null;
        if (v.Members != null)
            return "Struct{" + string.Join(",", v.Members
                .OrderBy(m => m.Name, StringComparer.Ordinal)
                .Select(m => $"{m.Name}={Canon(m.Value)}")) + "}";
        if (v.StructList != null)
            return "ArrayOfStruct[" + string.Join(",", v.StructList
                .Select(inst => "{" + string.Join(",", inst
                    .OrderBy(m => m.Name, StringComparer.Ordinal)
                    .Select(m => $"{m.Name}={Canon(m.Value)}")) + "}")) + "]";
        if (v.ListItems != null)
            return $"{v.Type}[" + string.Join(",", v.ListItems.Select(Canon)) + "]";
        var leaf = v.Type == "Object" ? $"{v.Value} [{v.Alias}]" : v.Value?.ToString() ?? "";
        return $"{v.Type}|{leaf}";
    }

    // Reduces all per-cell states to a record-level conflict contribution:
    // any ConflictWins/Loses => Conflict; else any Override => Override; else NoConflict.
    private sealed class ConflictAccumulator
    {
        private bool _conflict;
        private bool _override;

        public void Add(IReadOnlyDictionary<string, ConflictThis> states)
        {
            foreach (var s in states.Values)
            {
                if (s is ConflictThis.ConflictWins or ConflictThis.ConflictLoses) _conflict = true;
                else if (s == ConflictThis.Override) _override = true;
            }
        }

        public ConflictAll Result
        {
            get
            {
                if (_conflict) return ConflictAll.Conflict;
                return _override ? ConflictAll.Override : ConflictAll.NoConflict;
            }
        }
    }
}
