using MEditService.Index;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries;

// Single owner of the ADR-0018 two-axis model's decision rules, so a rule change cannot drift
// between the sites that fold per-plugin values through them.
internal static class ConflictRules
{
    // plugins.md: a non-participating plugin never contributes to conflict classification — filtered
    // out before any diff/winner/cell-state computation, not masked in the result. Null
    // pluginParticipates means every plugin participates (absent key: fail-open).
    public static IReadOnlyList<T> FilterParticipating<T>(
        IReadOnlyList<T> items, Func<T, string> plugin, IReadOnlyDictionary<string, bool>? pluginParticipates) =>
        pluginParticipates == null ? items : [.. items.Where(i => pluginParticipates.GetValueOrDefault(plugin(i), true))];

    // The field winner (highest load-order plugin with a value) is ConflictWins if contested by
    // another non-master plugin, else Override; the rest are IdenticalToMaster, ConflictLoses or
    // Override. `valuesEqual` is supplied so callers can use sorted-array-aware comparison.
    public static Dictionary<string, ConflictThis> ComputeCellStates(
        IReadOnlyDictionary<string, object?> valuesByPlugin,
        string masterPlugin,
        IReadOnlyList<(string Plugin, int LoadOrderIndex)> pluginOrder,
        Func<object?, object?, bool> valuesEqual)
    {
        var candidates = pluginOrder.Where(p => valuesByPlugin.GetValueOrDefault(p.Plugin) != null).ToList();
        if (candidates.Count == 0) return [];
        var winnerPlugin = candidates.MaxBy(p => p.LoadOrderIndex).Plugin;

        var ctx = new CellContext(
            masterPlugin, winnerPlugin,
            valuesByPlugin.GetValueOrDefault(masterPlugin), valuesByPlugin.GetValueOrDefault(winnerPlugin),
            pluginOrder, valuesByPlugin, valuesEqual);

        var cellStates = new Dictionary<string, ConflictThis>();
        foreach (var (plugin, _) in pluginOrder)
        {
            if (plugin == masterPlugin) continue;

            var pluginValue = valuesByPlugin.GetValueOrDefault(plugin);
            if (pluginValue == null) continue;

            cellStates[plugin] = ClassifyCell(plugin, pluginValue, ctx);
        }

        return cellStates;
    }

    private readonly record struct CellContext(
        string MasterPlugin, string WinnerPlugin, object? MasterValue, object? WinnerValue,
        IReadOnlyList<(string Plugin, int LoadOrderIndex)> PluginOrder,
        IReadOnlyDictionary<string, object?> ValuesByPlugin,
        Func<object?, object?, bool> ValuesEqual);

    private static ConflictThis ClassifyCell(string plugin, object? pluginValue, CellContext ctx)
    {
        if (ctx.ValuesEqual(pluginValue, ctx.MasterValue)) return ConflictThis.IdenticalToMaster;

        if (plugin == ctx.WinnerPlugin)
        {
            var contested = ctx.PluginOrder.Any(p =>
                p.Plugin != ctx.MasterPlugin && p.Plugin != plugin &&
                ctx.ValuesByPlugin.GetValueOrDefault(p.Plugin) is { } otherValue &&
                !ctx.ValuesEqual(otherValue, ctx.WinnerValue));
            return contested ? ConflictThis.ConflictWins : ConflictThis.Override;
        }

        return !ctx.ValuesEqual(pluginValue, ctx.WinnerValue) ? ConflictThis.ConflictLoses : ConflictThis.Override;
    }

    // One column's own state across every row: the most severe cell it holds, and Master for the
    // master's own column.
    public static ConflictThis AggregateThis(
        string column, string masterColumn, IEnumerable<IReadOnlyDictionary<string, ConflictThis>> rows)
    {
        if (column == masterColumn) return ConflictThis.Master;

        var states = rows.Where(r => r.ContainsKey(column)).Select(r => r[column]).ToList();
        return states switch
        {
            { Count: 0 } => ConflictThis.IdenticalToMaster,
            _ when states.Contains(ConflictThis.ConflictLoses) => ConflictThis.ConflictLoses,
            _ when states.Contains(ConflictThis.ConflictWins) => ConflictThis.ConflictWins,
            _ when states.Contains(ConflictThis.Override) => ConflictThis.Override,
            _ => ConflictThis.IdenticalToMaster,
        };
    }

    // An override whose master list omits the plugin the FormKey originates in has injected the
    // record into that plugin's FormID space.
    public static bool IsInjected(
        IReadOnlyList<RecordDetail> overrides,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters)
    {
        if (!FormKey.TryFactory(overrides[0].FormKey, out var formKey)) return false;
        var originPlugin = formKey.ModKey.FileName.String;

        return overrides.Skip(1).Any(o =>
            pluginMasters.TryGetValue(ColumnKey.Of(o.Plugin, o.Origin), out var masters) &&
            !masters.Contains(originPlugin, StringComparer.OrdinalIgnoreCase));
    }

    // Folds a set of per-cell states into the row-level ConflictAll contribution they imply:
    // any ConflictWins/ConflictLoses => Conflict; else any Override => Override; else NoConflict.
    public static ConflictAll Reduce(IEnumerable<ConflictThis> cellStates)
    {
        var hasConflict = false;
        var hasOverride = false;
        foreach (var state in cellStates)
        {
            if (state is ConflictThis.ConflictWins or ConflictThis.ConflictLoses) hasConflict = true;
            else if (state == ConflictThis.Override) hasOverride = true;
        }

        return (hasConflict, hasOverride) switch
        {
            (true, _) => ConflictAll.Conflict,
            (_, true) => ConflictAll.Override,
            _ => ConflictAll.NoConflict,
        };
    }

    // Takes the more severe of the two; OnlyOne and ConflictCritical are terminal and pass through.
    // Explicit severity table so this doesn't depend on enum declaration order.
    public static ConflictAll Escalate(ConflictAll generic, ConflictAll contribution)
    {
        return generic switch
        {
            ConflictAll.OnlyOne or ConflictAll.ConflictCritical => generic,
            _ => Severity(contribution) > Severity(generic) ? contribution : generic,
        };
    }

    private static int Severity(ConflictAll conflictAll) => conflictAll switch
    {
        ConflictAll.NoConflict => 0,
        ConflictAll.Override => 1,
        ConflictAll.Conflict => 2,
        _ => 3, // OnlyOne / ConflictCritical: terminal, never expected as a `contribution` argument.
    };
}
