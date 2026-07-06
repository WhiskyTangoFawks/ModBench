namespace MEditService.Core.Queries;

// Single owner of the ADR-0016 two-axis model's decision rules: both ConflictClassifier (generic
// reflected fields) and VmadConflictClassifier fold their per-plugin values through the same cell
// classification and row-level reduction here, so a rule change can't drift between the two paths.
public static class ConflictRules
{
    // Per-cell classification for one field/property: field winner (highest load-order plugin with
    // a value) is ConflictWins if contested by another non-master plugin, else Override; other
    // non-master plugins are IdenticalToMaster, ConflictLoses (differ from the winner), or Override.
    // Callers supply `valuesEqual` so generic fields can use sorted-array-aware comparison while VMAD
    // compares pre-canonicalized strings.
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

        if (hasConflict) return ConflictAll.Conflict;
        return hasOverride ? ConflictAll.Override : ConflictAll.NoConflict;
    }

    // Combines a generic-field ConflictAll with another axis's contribution (e.g. VMAD), taking the
    // more severe of the two. OnlyOne and ConflictCritical are terminal states that pass through
    // unchanged — explicit severity table so this doesn't depend on enum declaration order.
    public static ConflictAll Escalate(ConflictAll generic, ConflictAll contribution)
    {
        if (generic is ConflictAll.OnlyOne or ConflictAll.ConflictCritical) return generic;
        return Severity(contribution) > Severity(generic) ? contribution : generic;
    }

    private static int Severity(ConflictAll conflictAll) => conflictAll switch
    {
        ConflictAll.NoConflict => 0,
        ConflictAll.Override => 1,
        ConflictAll.Conflict => 2,
        _ => 3, // OnlyOne / ConflictCritical: terminal, never expected as a `contribution` argument.
    };
}
