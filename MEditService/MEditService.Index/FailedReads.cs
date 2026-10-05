using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Index;

/// <summary>A plugin that failed to read stays in its error state (ADR-0013) until what it reads
/// from changes, which the state recorded beside it detects.</summary>
internal sealed class FailedReads(DuckDbRecordIndex index)
{
    private readonly Lock _lock = new();
    private readonly Dictionary<PluginAddress, FailedRead?> _failed = new(PluginAddress.Comparer);

    // What a failed read read from: the binary's hash, and for a plugin with a tree, each document's
    // content stamp then, or the doubly claimed FormKey the tree named instead (ADR-0003).
    private sealed record FailedRead(string? Binary, RecordStamps? Stamps, string? Ambiguity = null);

    public IReadOnlyList<PluginAddress> Keys
    {
        get { lock (_lock) return [.. _failed.Keys]; }
    }

    /// <summary>While what it reads from is unchanged the error state stands, and the parse is not
    /// paid again.</summary>
    public bool StillFailing(PluginAddress key, string path)
    {
        FailedRead? failedAt;
        lock (_lock)
        {
            if (!_failed.TryGetValue(key, out failedAt)) return false;
        }
        return failedAt is not null && ReadStateOf(key, path) is { } now && failedAt == now;
    }

    /// <summary>Remembers the bytes (or tree) the plugin failed on.</summary>
    public void Remember(PluginAddress key, string path)
    {
        var state = ReadStateOf(key, path);
        lock (_lock) _failed[key] = state;
    }

    /// <summary>Remembers a failure that vouches for nothing: a file another process held is read
    /// again at the next snapshot, whatever it reads from.</summary>
    public void RememberUntilTheNextSnapshot(PluginAddress key)
    {
        lock (_lock) _failed[key] = null;
    }

    public void Forget(PluginAddress key)
    {
        lock (_lock) _failed.Remove(key);
    }

    // Null, which vouches for nothing, when what the plugin reads from cannot be read: an untracked
    // binary, or a tree with an unreadable document.
    private FailedRead? ReadStateOf(PluginAddress key, string path)
    {
        var binary = index.FileContentHash(path);
        if (LoadOrderSnapshot.ModFolderOf(key.Origin, path) is not { } modFolder
            || !SourceRepository.HoldsTreeFor(modFolder, key.Name))
        {
            return binary is null ? null : new FailedRead(binary, null);
        }

        try
        {
            var stamps = SourceRepository.Over(modFolder, index.Release).StampsOf(key);
            return stamps.Unreadable.Count == 0 ? new FailedRead(binary, stamps) : null;
        }
        catch (AmbiguousSourceUnitException ex)
        {
            return new FailedRead(binary, null, ex.Message);
        }
    }
}
