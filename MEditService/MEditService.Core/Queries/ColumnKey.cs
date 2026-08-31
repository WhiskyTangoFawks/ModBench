using MEditService.Core.Plugins;

namespace MEditService.Core.Queries;

// ADR-0036: the compound identity a compare-grid column is keyed by everywhere two
// same-filename, different-origin columns must stay distinguishable — FieldDiff.Values/CellStates/
// Resolutions, VmadPropertyDiff/VmadScriptDiff/ConditionDiff's equivalents, ClassifyResult.
// PluginStates, SaveGroupResponse.ByPlugin. `|` is illegal in a Windows filename and an MO2
// mod-folder name, so it can't collide with either half's own content, and it avoids `:`, already
// load-bearing in the "000000:<plugin>" synthetic header FormKey and "param:{i}" field-cell-state
// paths.
//
// PluginOrigin.DataDirectory is elided: a plugin resolved from the game's single Data directory is
// already uniquely identified by its filename (there is only one Data/), so the plain filename is
// itself a collision-free key for that case, not a shortcut that loses information. ADR-0044 makes
// a winning and a losing copy sharing a filename routine; ColumnKeyTests/
// DuplicateFilenameLoadOrderApiTests exercise the multi-origin case directly.
public static class ColumnKey
{
    private const char Delimiter = '|';

    public static string Of(string plugin, string origin) =>
        string.Equals(origin, PluginOrigin.DataDirectory, StringComparison.OrdinalIgnoreCase)
            ? plugin
            : $"{plugin}{Delimiter}{origin}";
}

// Marks a DTO property whose dictionary keys are `ColumnKey.Of(plugin, origin)` values — the
// single source of truth `CompareResultColumnKeyIntegrityTests` reflects over, instead of a
// hand-typed property-name allowlist, which drifts. Sits next to the property it marks, so adding
// a new column-keyed dictionary means annotating it here, not remembering to also update a test
// file elsewhere.
//
// A dictionary whose *values* are themselves column-keyed dictionaries (FieldCellStates/
// FieldResolutions: outer key is a field id like "function"/"param:0", inner key is the column) is
// marked the same way — the integrity test detects the nesting structurally (is TValue itself a
// string-keyed dictionary?) rather than needing a second attribute flavor.
[AttributeUsage(AttributeTargets.Property)]
public sealed class ColumnKeyedAttribute : Attribute;
