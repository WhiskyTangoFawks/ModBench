using MEditService.Core.Session;

namespace MEditService.Core.Queries;

// #272 / ADR-0036: the compound identity a compare-grid column is keyed by everywhere two
// same-filename, different-origin columns must stay distinguishable — FieldDiff.Values/CellStates/
// Resolutions, VmadPropertyDiff/VmadScriptDiff/ConditionDiff's equivalents, ClassifyResult.
// PluginStates, SaveGroupResponse.ByPlugin. `|` is illegal in a Windows filename and an MO2
// mod-folder name, so it can't collide with either half's own content, and it avoids `:`, already
// load-bearing in the "000000:<plugin>" synthetic header FormKey and "param:{i}" field-cell-state
// paths.
//
// PluginOrigin.DataDirectory is elided: a plugin resolved from the game's single Data directory is
// already uniquely identified by its filename (there is only one Data/), so the plain filename is
// itself a collision-free key for that case, not a shortcut that loses information. This keeps
// every existing single-origin fixture/session (the overwhelming common case today, since two
// same-filename plugins can't load together until #34) producing the exact plain-filename keys it
// always has — the whole test suite doesn't need rekeying for a case nothing exercises yet.
public static class ColumnKey
{
    public const char Delimiter = '|';

    public static string Of(string plugin, string origin) =>
        string.Equals(origin, PluginOrigin.DataDirectory, StringComparison.OrdinalIgnoreCase)
            ? plugin
            : $"{plugin}{Delimiter}{origin}";
}
