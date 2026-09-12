using MEditService.LoadOrder;

namespace MEditService.Index;

// ADR-0012: the compound identity compare-grid columns are keyed by. `|` is illegal in a Windows
// filename and an MO2 mod-folder name; `:` was rejected as already load-bearing in the
// "000000:<plugin>" and "param:{i}" paths.
public static class ColumnKey
{
    private const char Delimiter = '|';

    // A Data-directory plugin is unique by filename alone, so it keys as the bare filename.
    public static string Of(string plugin, string origin) =>
        string.Equals(origin, PluginOrigin.DataDirectory, StringComparison.OrdinalIgnoreCase)
            ? plugin
            : $"{plugin}{Delimiter}{origin}";
}
