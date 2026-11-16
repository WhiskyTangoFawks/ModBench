using MEditService.LoadOrder;

namespace MEditService.Ports;

/// <summary>Each compiled plugin changed outside Modbench, by the mod it came from (ADR-0003): a mod's whole
/// answer, so a plugin it leaves out matches.</summary>
public sealed class ChangedOutside
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, IReadOnlyList<string>> _byOrigin = new(StringComparer.Ordinal);

    public bool Holds(PluginAddress plugin)
    {
        lock (_lock)
            return _byOrigin.TryGetValue(plugin.Origin, out var changed) && changed.Contains(plugin.Name);
    }

    /// <summary>Replaces what <paramref name="origin"/> last named, and answers the plugins whose standing flipped.</summary>
    public IReadOnlyList<PluginAddress> Replace(string origin, IReadOnlyList<string> plugins)
    {
        lock (_lock)
        {
            var before = (_byOrigin.TryGetValue(origin, out var held) ? held : []).ToHashSet(StringComparer.Ordinal);
            var after = plugins.ToHashSet(StringComparer.Ordinal);
            if (plugins.Count == 0) _byOrigin.Remove(origin);
            else _byOrigin[origin] = plugins;
            return [.. before.Except(after).Concat(after.Except(before)).Select(name => new PluginAddress(name, origin))];
        }
    }
}
