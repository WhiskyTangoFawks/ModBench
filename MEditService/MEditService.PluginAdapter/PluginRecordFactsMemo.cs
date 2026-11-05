using System.Collections.Concurrent;
using MEditService.RepositoriesLib;

namespace MEditService.PluginAdapter;

/// <summary>Each plugin's <see cref="PluginRecordFacts"/>, kept by the plugin's stamp (ADR-0003) and by what
/// else the facts read: a change to either reads them again.</summary>
internal sealed class PluginRecordFactsMemo(TimeProvider timeProvider)
{
    private readonly ConcurrentDictionary<string, (string Dependencies, StampGatedMemo<PluginRecordFacts> Memo)> _known = new(StringComparer.Ordinal);

    /// <summary><paramref name="read"/> opens its own mod, after the stamp is taken, so the facts are of the bytes the stamp names.</summary>
    internal PluginRecordFacts Of(string path, string dependencies, Func<PluginRecordFacts> read)
    {
        var (_, memo) = _known.AddOrUpdate(
            path,
            _ => (dependencies, new StampGatedMemo<PluginRecordFacts>(timeProvider)),
            (_, held) => held.Dependencies == dependencies ? held : (dependencies, new StampGatedMemo<PluginRecordFacts>(timeProvider)));
        return memo.Of(path, read) ?? throw new InvalidOperationException("Expected a walk of the mod to answer its facts.");
    }

    internal void Retain(IReadOnlySet<string> paths)
    {
        foreach (var path in _known.Keys.Where(path => !paths.Contains(path))) _known.TryRemove(path, out _);
    }
}
