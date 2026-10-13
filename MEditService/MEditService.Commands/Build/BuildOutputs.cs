namespace MEditService.Commands.Build;

/// <summary>The files of a mod folder that compile writes for its plugins: each plugin, and each localized plugin's
/// strings, which the game finds as <c>Strings/&lt;plugin&gt;_&lt;language&gt;.&lt;kind&gt;</c>.</summary>
internal static class BuildOutputs
{
    private static readonly string[] StringsKinds = [".strings", ".dlstrings", ".ilstrings"];

    /// <summary>Whether compile writes <paramref name="path"/>, forward-slash and relative to the mod folder.</summary>
    internal static bool Holds(IEnumerable<string> plugins, string path) =>
        plugins.Any(plugin => string.Equals(path, plugin, StringComparison.OrdinalIgnoreCase) || IsStringsOf(plugin, path));

    private static bool IsStringsOf(string plugin, string path)
    {
        const string folder = "Strings/";
        var stem = plugin[..plugin.LastIndexOf('.')];
        return path.StartsWith(folder, StringComparison.OrdinalIgnoreCase)
            && path.IndexOf('/', folder.Length) < 0
            && path[folder.Length..].StartsWith(stem + "_", StringComparison.OrdinalIgnoreCase)
            && StringsKinds.Any(kind => path.EndsWith(kind, StringComparison.OrdinalIgnoreCase));
    }
}
