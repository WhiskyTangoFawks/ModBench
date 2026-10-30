using System.Collections.Concurrent;

namespace MEditService.RepositoriesLib;

/// <summary>A value kept by its file's <see cref="FileStamp"/> and read again once the stamp is too recent
/// to trust (ADR-0003). The owner holds the instance and with it the state.</summary>
public sealed class StampGatedMemo<TValue>(TimeProvider timeProvider) where TValue : class
{
    private readonly ConcurrentDictionary<string, (FileStamp Stamp, TValue Value)> _known = new(StringComparer.Ordinal);

    /// <summary>The remembered value while the file's stamp is unchanged, else <paramref name="read"/>'s
    /// answer. A null answer is passed on and remembers nothing.</summary>
    public TValue? Of(string path, Func<TValue?> read)
    {
        var stamp = FileStamp.Of(path);
        if (stamp is { } current && _known.TryGetValue(path, out var known) && known.Stamp == current)
            return known.Value;

        var readFrom = timeProvider.GetUtcNow();
        var value = read();
        if (stamp is { } before && value is not null && before.SettledAt(readFrom))
            _known[path] = (before, value);
        else
            _known.TryRemove(path, out _);
        return value;
    }

    public void Retain(IReadOnlySet<string> paths)
    {
        foreach (var path in _known.Keys.Where(path => !paths.Contains(path))) _known.TryRemove(path, out _);
    }
}
