using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Each tracked plugin changed outside Modbench (ADR-0003), and each tracked mod's
/// plugins whose plugin source is unreadable.</summary>
internal sealed class ExternalChangeCheck(INotificationPublisher notifications, IPluginAdapter adapter)
{
    private readonly Lock _checking = new();
    // A mod whose repository went since is told it names no changed plugin.
    private HashSet<string> _trackedAtLastCheck = new(StringComparer.Ordinal);

    public void Check(LoadOrderSnapshot snapshot)
    {
        var mods = snapshot.Plugins
            .Where(plugin => plugin.Provider is PluginProvider.FromMod)
            .GroupBy(plugin => (PluginProvider.FromMod)plugin.Provider);

        lock (_checking)
        {
            var tracked = new HashSet<string>(StringComparer.Ordinal);
            foreach (var mod in mods)
            {
                if (SourceRepository.Open(mod.Key, snapshot.GameRelease) is { } repository)
                {
                    tracked.Add(mod.Key.Folder);
                    Tell(mod.Key.Name, repository, [.. mod]);
                }
                else if (_trackedAtLastCheck.Contains(mod.Key.Folder))
                {
                    notifications.Publish(new ExternalChangeNotification(mod.Key.Name, []));
                }
            }
            _trackedAtLastCheck = tracked;
        }
    }

    private void Tell(string origin, SourceRepository repository, IReadOnlyList<RegisteredPlugin> plugins)
    {
        var sourceReads = plugins.ToLookup(plugin => SourceRepository.SourceReads(plugin));
        notifications.Publish(new ExternalChangeNotification(origin, [.. sourceReads[true]
            .Select(plugin => (plugin.Key, Observed: adapter.HashOf(plugin.Path)))
            .Where(plugin => !MatchesLastWrite(repository, plugin.Key, plugin.Observed))
            .Select(plugin => new ChangedPlugin(plugin.Key.Name, plugin.Observed))]));

        if (sourceReads[false].Any())
            notifications.Publish(new PluginSourceUnreadableNotification(origin, [.. sourceReads[false].Select(plugin => plugin.Name)]));
    }

    // Bytes that cannot be read, or a last write that cannot, match nothing (ADR-0003).
    private static bool MatchesLastWrite(SourceRepository repository, PluginAddress plugin, string? observed) =>
        observed is not null
        && repository.LastWrittenBinarySha256s(plugin).Contains(observed, StringComparer.OrdinalIgnoreCase);
}
