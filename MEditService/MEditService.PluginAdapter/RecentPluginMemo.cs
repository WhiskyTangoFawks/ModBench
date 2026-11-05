using MEditService.RepositoriesLib;

namespace MEditService.PluginAdapter;

/// <summary>A value read of a plugin's file, kept by the file's stamp (ADR-0003) and by what else it reads,
/// for the plugins most recently asked about.</summary>
internal sealed class RecentPluginMemo<TValue>(TimeProvider timeProvider, int capacity) where TValue : class
{
    private readonly object _gate = new();
    private readonly List<(string Path, string Dependencies, StampGatedMemo<TValue> Memo)> _recent = [];

    /// <summary><paramref name="read"/> opens the file itself, after the stamp is taken.</summary>
    public TValue Of(string path, string dependencies, Func<TValue> read)
    {
        StampGatedMemo<TValue> memo;
        lock (_gate)
        {
            var at = _recent.FindIndex(held => held.Path == path);
            memo = at >= 0 && _recent[at].Dependencies == dependencies ? _recent[at].Memo : new StampGatedMemo<TValue>(timeProvider);
            if (at >= 0) _recent.RemoveAt(at);
            _recent.Add((path, dependencies, memo));
            if (_recent.Count > capacity) _recent.RemoveAt(0);
        }
        return memo.Of(path, read) ?? throw new InvalidOperationException("Expected a read of a plugin to answer its value.");
    }

    public void Retain(IReadOnlySet<string> paths)
    {
        lock (_gate) _recent.RemoveAll(held => !paths.Contains(held.Path));
    }
}
