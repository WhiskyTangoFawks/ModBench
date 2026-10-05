using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Each tracked plugin changed outside Modbench (ADR-0003), and each tracked mod's
/// untracked plugins.</summary>
internal sealed class ExternalChangeCheck(INotificationPublisher notifications, PluginFileHashes hashes)
{
    private readonly Lock _checking = new();
    // A mod whose repository went since is told it names no changed plugin.
    private HashSet<string> _trackedAtLastCheck = new(StringComparer.Ordinal);

    public void Check(LoadOrderSnapshot snapshot)
    {
        // The origin is the mod manager's name for the mod, which only a plugin of it carries.
        var mods = snapshot.Plugins
            .SelectMany(plugin => LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path) is { } modFolder
                ? [(Plugin: plugin, ModFolder: modFolder)]
                : Array.Empty<(RegisteredPlugin Plugin, string ModFolder)>())
            .GroupBy(p => p.ModFolder, p => p.Plugin, StringComparer.Ordinal);

        lock (_checking)
        {
            var tracked = new HashSet<string>(StringComparer.Ordinal);
            foreach (var mod in mods)
            {
                var origin = mod.First().Origin;
                if (SourceRepository.Open(mod.Key, snapshot.GameRelease) is { } repository)
                {
                    tracked.Add(mod.Key);
                    Tell(origin, repository, [.. mod]);
                }
                else if (_trackedAtLastCheck.Contains(mod.Key))
                {
                    notifications.Publish(new ExternalChangeNotification(origin, []));
                }
            }
            _trackedAtLastCheck = tracked;
        }
    }

    private void Tell(string origin, SourceRepository repository, IReadOnlyList<RegisteredPlugin> plugins)
    {
        var tracked = plugins.ToLookup(plugin => repository.HoldsTreeFor(plugin.Key));
        notifications.Publish(new ExternalChangeNotification(origin, [.. tracked[true]
            .Select(plugin => (plugin.Key, Observed: hashes.Of(plugin.Path)))
            .Where(plugin => !MatchesLastWrite(repository, plugin.Key, plugin.Observed))
            .Select(plugin => new ChangedPlugin(plugin.Key.Name, plugin.Observed))]));

        if (tracked[false].Any())
            notifications.Publish(new UntrackedPluginsNotification(origin, [.. tracked[false].Select(plugin => plugin.Name)]));
    }

    // Bytes that cannot be read, or a last write that cannot, match nothing (ADR-0003).
    private static bool MatchesLastWrite(SourceRepository repository, PluginAddress plugin, string? observed) =>
        observed is not null
        && repository.LastWrittenBinarySha256s(plugin).Contains(observed, StringComparer.OrdinalIgnoreCase);
}
