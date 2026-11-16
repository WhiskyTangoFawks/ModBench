using MEditService.LoadOrder;

namespace MEditService.RecordIndex;

/// <summary>Each compiled plugin changed outside Modbench, by the mod it came from (ADR-0003): a mod's whole
/// answer, so a plugin it leaves out matches.</summary>
internal sealed class ChangedOutside
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, IReadOnlyList<string>> _byOrigin = new(StringComparer.Ordinal);

    internal bool Holds(PluginAddress plugin)
    {
        lock (_lock)
            return _byOrigin.TryGetValue(plugin.Origin, out var changed) && changed.Contains(plugin.Name);
    }

    internal IReadOnlyList<string> Of(string origin)
    {
        lock (_lock) return _byOrigin.TryGetValue(origin, out var changed) ? changed : [];
    }

    /// <summary>Replaces what <paramref name="origin"/> last named, and answers the plugins whose standing flipped.</summary>
    internal IReadOnlyList<PluginAddress> Replace(string origin, IReadOnlyList<string> plugins)
    {
        lock (_lock)
        {
            var before = Of(origin).ToHashSet(StringComparer.Ordinal);
            var after = plugins.ToHashSet(StringComparer.Ordinal);
            if (plugins.Count == 0) _byOrigin.Remove(origin);
            else _byOrigin[origin] = plugins;
            return [.. before.Except(after).Concat(after.Except(before)).Select(name => new PluginAddress(name, origin))];
        }
    }
}
