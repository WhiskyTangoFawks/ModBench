namespace MEditService.Core.Source;

/// <summary>
/// A per-operation memo for <see cref="SourceUnitResolver.Resolve"/>. Compile's diagnostics
/// pass resolves every record that has something to report against one tree; without this, each
/// folder-split child (a dialog response, a scene) re-enumerated its whole subtree to find its own
/// file, and each embedded child re-read and re-scanned its parent — on the real 3,940-record
/// fixture, 2,198 responses × ~2,600 files was 25 of Compile's 42 seconds, and 96% of it overall.
///
/// <para><b>A snapshot for the life of one operation, deliberately.</b> One listing per scan root
/// is what turns the pass from O(records × tree) into O(tree); a single compile does not expect the
/// tree to move under it, and a caller that does (the edit path's single-record resolves) simply
/// passes none. Never shared across operations — never-assume-exclusive-ownership means the next
/// compile must look again.</para>
/// </summary>
internal sealed class SourceUnitResolutionCache
{
    private readonly Dictionary<string, string[]> _entries = new(StringComparer.Ordinal);

    /// <summary>Resolved units of container records that embedded children resolve through, keyed by
    /// the owner's FormKey — one cell's worth of placed refs shares one read and one scan.</summary>
    internal Dictionary<string, SourceUnit?> Owners { get; } = new(StringComparer.Ordinal);

    /// <summary>Every file-system entry under <paramref name="scanRoot"/>, recursively, enumerated
    /// once. The caller applies its own name filter in memory.</summary>
    internal string[] EntriesUnder(string scanRoot)
    {
        if (_entries.TryGetValue(scanRoot, out var cached)) return cached;
        var entries = Directory.EnumerateFileSystemEntries(scanRoot, "*", SearchOption.AllDirectories).ToArray();
        _entries[scanRoot] = entries;
        return entries;
    }
}
