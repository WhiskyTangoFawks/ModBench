using System.Security.Cryptography;

namespace MEditService.Tests.TestSupport;

/// <summary>A filesystem oracle beside <c>git status</c>: git tracks files, not directories, so a stray
/// empty record directory is invisible to status while failing the next ingest.</summary>
internal static class TreeSnapshot
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
                : $"file {relative} {Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(entry)))}");
        }

        lines.Sort(StringComparer.Ordinal);
        return lines;
    }
}
