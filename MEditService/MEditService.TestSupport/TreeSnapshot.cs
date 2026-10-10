using System.Security.Cryptography;

namespace MEditService.TestSupport;

/// <summary>A filesystem oracle beside <c>git status</c>: git tracks files, not directories, so a stray
/// empty record directory is invisible to status while failing the next ingest.</summary>
public static class TreeSnapshot
{
    public static IReadOnlyList<string> Of(string root)
    {
        var lines = new List<string>();
        foreach (var entry in Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(root, entry).Replace('\\', '/');
            if (relative == ".git" || relative.StartsWith(".git/", StringComparison.Ordinal)) continue;

            lines.Add(Directory.Exists(entry)
                ? $"dir  {relative}"
                : $"file {relative} {HashOf(entry)}");
        }

        lines.Sort(StringComparer.Ordinal);
        return lines;
    }

    private const int SharingViolation = unchecked((int)0x80070020);

    // A file another process holds open against every reader, as DuckDB holds the backend's index on
    // Windows, is named as held: its bytes cannot be read until it lets go.
    private static string HashOf(string file)
    {
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return Convert.ToHexString(SHA256.HashData(stream));
        }
        catch (IOException ex) when (ex.HResult == SharingViolation)
        {
            return "held";
        }
    }
}
