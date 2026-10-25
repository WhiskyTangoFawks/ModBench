namespace MEditService.RecordIndex.Queries;

// Single owner of ADR-0018's two-axis model's decision rules, so a rule change cannot drift
// between the sites that fold per-plugin values through them.
internal static class ConflictRules
{
    // The field winner (highest load-order plugin taking part) is ConflictWins if contested by
    // another non-master plugin, else Override; the rest are IdenticalToMaster, ConflictLoses or
    // Override. A plugin takes part with an absent value too, since a copy that drops a field
    // changes it (xEdit); a sparse plugin takes part only where it holds a value.
    public static Dictionary<string, ConflictThis> ComputeCellStates(
        IReadOnlyDictionary<string, object?> valuesByPlugin,
        string masterPlugin,
        IReadOnlyList<(string Plugin, int LoadOrderIndex)> pluginOrder,
        IReadOnlySet<string> sparsePlugins,
        Func<object?, object?, bool> valuesEqual)
    {
        var taking = pluginOrder.Where(p => valuesByPlugin.GetValueOrDefault(p.Plugin) != null || !sparsePlugins.Contains(p.Plugin)).ToList();
        if (taking.All(p => valuesByPlugin.GetValueOrDefault(p.Plugin) == null)) return [];
        var winnerPlugin = taking.MaxBy(p => p.LoadOrderIndex).Plugin;
        var ctx = new CellContext(
            masterPlugin, winnerPlugin,
            valuesByPlugin.GetValueOrDefault(masterPlugin), valuesByPlugin.GetValueOrDefault(winnerPlugin),
            taking, valuesByPlugin, valuesEqual);

        var cellStates = new Dictionary<string, ConflictThis>();
        foreach (var (plugin, _) in taking)
        {
            if (plugin == masterPlugin) continue;

            var pluginValue = valuesByPlugin.GetValueOrDefault(plugin);

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
                !ctx.ValuesEqual(ctx.ValuesByPlugin.GetValueOrDefault(p.Plugin), ctx.WinnerValue));
            return contested ? ConflictThis.ConflictWins : ConflictThis.Override;
        }

        return !ctx.ValuesEqual(pluginValue, ctx.WinnerValue) ? ConflictThis.ConflictLoses : ConflictThis.Override;
    }

    public static bool AllSame(IEnumerable<object?> values, Func<object?, object?, bool> valuesEqual)
    {
        var all = values.ToList();
        return all.TrueForAll(value => valuesEqual(all[0], value));
    }

    // xEdit's Compare Selected paint: the focused column is Master, and every other cell is
    // Override where its value is the focused cell's, ConflictLoses where it is not.
    public static Dictionary<string, IReadOnlyDictionary<string, ConflictThis>> StatesByFocus(
        IReadOnlyDictionary<string, object?> valuesByColumn, Func<object?, object?, bool> valuesEqual)
    {
        ConflictThis StateOf(string focused, string column) => column == focused ? ConflictThis.Master
            : ComparedWith(valuesByColumn[focused], valuesByColumn[column], valuesEqual);

        return valuesByColumn.Keys.ToDictionary(
            focused => focused,
            focused => (IReadOnlyDictionary<string, ConflictThis>)valuesByColumn.Keys.ToDictionary(column => column, column => StateOf(focused, column)));
    }

    private static ConflictThis ComparedWith(object? focused, object? cell, Func<object?, object?, bool> valuesEqual) =>
        valuesEqual(focused, cell) ? ConflictThis.Override : ConflictThis.ConflictLoses;

    // One column's own state across every row: the most severe cell it holds, Master for the
    // master's own column, and none for a column with no cell.
    public static ConflictThis? AggregateThis(
        string column, string masterColumn, IEnumerable<IReadOnlyDictionary<string, ConflictThis>> rows)
    {
        if (column == masterColumn) return ConflictThis.Master;

        var states = rows.Where(r => r.ContainsKey(column)).Select(r => r[column]).ToList();
        return states switch
        {
            { Count: 0 } => null,
            _ when states.Contains(ConflictThis.ConflictLoses) => ConflictThis.ConflictLoses,
            _ when states.Contains(ConflictThis.ConflictWins) => ConflictThis.ConflictWins,
            _ when states.Contains(ConflictThis.Override) => ConflictThis.Override,
            _ => ConflictThis.IdenticalToMaster,
        };
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

    // Takes the more severe of the two; OnlyOne is terminal and passes through.
    // Explicit severity table so this doesn't depend on enum declaration order.
    private static ConflictAll Escalate(ConflictAll generic, ConflictAll contribution)
    {
        return generic switch
        {
            ConflictAll.OnlyOne => generic,
            _ => Severity(contribution) > Severity(generic) ? contribution : generic,
        };
    }

    public static ConflictAll Worst(ConflictAll seed, IEnumerable<ConflictAll> contributions) =>
        contributions.Aggregate(seed, Escalate);

    private static int Severity(ConflictAll conflictAll) => conflictAll switch
    {
        ConflictAll.NoConflict => 0,
        ConflictAll.Override => 1,
        ConflictAll.Conflict => 2,
        ConflictAll.ConflictBenign => 3,
        _ => 4, // OnlyOne: terminal, never expected as a `contribution` argument.
    };
}
