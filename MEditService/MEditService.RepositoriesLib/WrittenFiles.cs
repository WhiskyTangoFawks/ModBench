using System.Collections.Concurrent;

namespace MEditService.RepositoriesLib;

/// <summary>The files a write writes, each named by the repository that writes it, so the write's answer names them to the
/// caller that reads them again (ADR-0029). A path below another named stands in it.</summary>
public static class WrittenFiles
{
    private static readonly AsyncLocal<ConcurrentQueue<string>?> s_named = new();

    public static void Name(params string[] paths)
    {
        if (s_named.Value is not { } named) return;
        foreach (var path in paths) named.Enqueue(Path.GetFullPath(path));
    }

    /// <summary>Makes <paramref name="directory"/> and each folder above it that is missing, naming the topmost it made.</summary>
    public static void CreateDirectory(string directory)
    {
        var topmost = Path.GetFullPath(directory);
        if (Directory.Exists(topmost)) return;
        while (Path.GetDirectoryName(topmost) is { } parent && !Directory.Exists(parent)) topmost = parent;
        Directory.CreateDirectory(directory);
        Name(topmost);
    }

    public static async Task<(T Answer, IReadOnlyList<string> Written)> Of<T>(Func<Task<T>> write)
    {
        var named = new ConcurrentQueue<string>();
        s_named.Value = named;
        return (await write(), Roots(named));
    }

    public static (T Answer, IReadOnlyList<string> Written) Of<T>(Func<T> write)
    {
        var outer = s_named.Value;
        var named = new ConcurrentQueue<string>();
        s_named.Value = named;
        try
        {
            return (write(), Roots(named));
        }
        finally
        {
            s_named.Value = outer;
        }
    }

    private static List<string> Roots(IEnumerable<string> named)
    {
        var comparer = FilePaths.Comparison == StringComparison.Ordinal ? StringComparer.Ordinal : StringComparer.OrdinalIgnoreCase;
        var roots = new HashSet<string>(comparer);
        foreach (var path in named.OrderBy(path => path.Length))
        {
            if (!AncestorsOf(path).Any(roots.Contains)) roots.Add(path);
        }
        return [.. roots];
    }

    private static IEnumerable<string> AncestorsOf(string path)
    {
        for (var folder = Path.GetDirectoryName(path); !string.IsNullOrEmpty(folder); folder = Path.GetDirectoryName(folder)) yield return folder;
    }
}
