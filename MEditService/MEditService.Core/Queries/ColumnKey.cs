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

// #272 review: marks a DTO property whose dictionary keys are `ColumnKey.Of(plugin, origin)`
// values — the single source of truth `CompareResultColumnKeyIntegrityTests` reflects over,
// instead of a hand-typed property-name allowlist (which drifted three times on this ticket alone:
// missed `VmadPropertyDiff.Raw`, `ConditionDiff.FieldCellStates`, `ConditionDiff.FieldResolutions`,
// and carried one dead entry, `ClassifyResult.PluginStates`, which is never itself serialized).
// Sits next to the property it marks, so adding a new column-keyed dictionary means annotating it
// here, not remembering to also update a test file elsewhere.
//
// A dictionary whose *values* are themselves column-keyed dictionaries (FieldCellStates/
// FieldResolutions: outer key is a field id like "function"/"param:0", inner key is the column) is
// marked the same way — the integrity test detects the nesting structurally (is TValue itself a
// string-keyed dictionary?) rather than needing a second attribute flavor.
[AttributeUsage(AttributeTargets.Property)]
public sealed class ColumnKeyedAttribute : Attribute;
