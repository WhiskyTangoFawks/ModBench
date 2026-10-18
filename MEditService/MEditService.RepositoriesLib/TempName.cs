namespace MEditService.RepositoriesLib;

/// <summary>The name of a file or folder Modbench holds a write in until it renames it into place.
/// A leftover from a killed write is Modbench's artifact, never a mod's file.</summary>
public static class TempName
{
    private const string Prefix = ".medit_tmp_";
    private static readonly TimeSpan StaleAfter = TimeSpan.FromMinutes(1);

    public static string In(string folder, string suffix = "") =>
        Path.Combine(folder, Prefix + Path.GetRandomFileName() + suffix);

    public static bool IsTemp(string name) => name.StartsWith(Prefix, StringComparison.Ordinal);

    public static bool HoldsTemp(string forwardSlashPath) => forwardSlashPath.Split('/').Any(IsTemp);

    /// <summary>True when every file the temp holds was last changed long enough ago that no write is still
    /// filling it. A folder holding no file is never stale: a write may be about to fill it.</summary>
    public static bool IsStale(string path, DateTimeOffset now)
    {
        var files = Directory.Exists(path) ? Directory.GetFiles(path, "*", SearchOption.AllDirectories) : [path];
        return files.Length > 0 && files.All(file => FileStamp.Of(file) is { } stamp && stamp.ChangedBefore(now - StaleAfter));
    }
}
