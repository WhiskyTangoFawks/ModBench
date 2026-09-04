using MEditService.Core.Plugins;

namespace MEditService.Core.Queries;

// ADR-0036: the compound identity compare-grid columns are keyed by. `|` is illegal in a Windows
// filename and an MO2 mod-folder name, so neither half can contain it.
public static class ColumnKey
{
    private const char Delimiter = '|';

    // A Data-directory plugin is unique by filename alone, so it keys as the bare filename.
    public static string Of(string plugin, string origin) =>
        string.Equals(origin, PluginOrigin.DataDirectory, StringComparison.OrdinalIgnoreCase)
            ? plugin
            : $"{plugin}{Delimiter}{origin}";
}

// Marks a DTO property whose dictionary keys are ColumnKey.Of values; the column-key integrity
// test reflects over this instead of a hand-typed property-name allowlist, which drifts. A
// nested column-keyed dictionary is marked the same way.
[AttributeUsage(AttributeTargets.Property)]
public sealed class ColumnKeyedAttribute : Attribute;
