namespace MEditService.Core.Source;

/// <summary>A per-operation memo for <see cref="SourceUnitResolver.Resolve"/>: one listing per scan
/// root turns Compile's diagnostics pass from O(records × tree) into O(tree). Never shared across
/// operations — the next compile must look again.</summary>
internal sealed class SourceUnitResolutionCache
{
    private readonly Dictionary<string, string[]> _entries = new(StringComparer.Ordinal);

    /// <summary>Source roots whose embedded-owner map this pass has already read the tree for, so a
    /// whole mod's misses cost one rescan rather than one each.</summary>
    internal HashSet<string> RescannedOwnerMaps { get; } = new(StringComparer.Ordinal);

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
