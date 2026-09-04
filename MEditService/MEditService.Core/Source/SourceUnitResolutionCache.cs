namespace MEditService.Core.Source;

/// <summary>A per-operation memo for <see cref="SourceUnitResolver.Resolve"/>: one listing per scan
/// root turns Compile's diagnostics pass from O(records × tree) into O(tree). Never shared across
/// operations — the next compile must look again.</summary>
internal sealed class SourceUnitResolutionCache
{
    private readonly Dictionary<string, string[]> _entries = new(StringComparer.Ordinal);

    /// <summary>Resolved units of owner containers, keyed by the owner's FormKey — one cell's worth of
    /// placed refs shares one read and one scan.</summary>
    internal Dictionary<string, SourceUnit?> Owners { get; } = new(StringComparer.Ordinal);

    /// <summary>Every entry under <paramref name="scanRoot"/>, recursively, enumerated once; the caller
    /// filters by name in memory.</summary>
    internal string[] EntriesUnder(string scanRoot)
    {
        if (_entries.TryGetValue(scanRoot, out var cached)) return cached;
        var entries = Directory.EnumerateFileSystemEntries(scanRoot, "*", SearchOption.AllDirectories).ToArray();
        _entries[scanRoot] = entries;
        return entries;
    }
}
