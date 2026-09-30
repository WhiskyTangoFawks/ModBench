using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>ADR-0003 invariant 3, at each snapshot: each tracked plugin's bytes against what Modbench
/// last wrote, and each tracked mod's untracked plugins. It keeps and refuses nothing.</summary>
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
                if (SourceRepository.IsTracked(mod.Key))
                {
                    tracked.Add(mod.Key);
                    Tell(origin, mod.Key, [.. mod]);
                }
                else if (_trackedAtLastCheck.Contains(mod.Key))
                {
                    notifications.Publish(new ExternalChangeNotification(origin, []));
                }
            }
            _trackedAtLastCheck = tracked;
        }
    }

    private void Tell(string origin, string modFolder, IReadOnlyList<RegisteredPlugin> plugins)
    {
        var tracked = plugins.ToLookup(plugin => SourceRepository.HoldsTreeFor(modFolder, plugin.Name));
        notifications.Publish(new ExternalChangeNotification(origin, [.. tracked[true]
            .Select(plugin => new ChangedPlugin(plugin.Name, hashes.Of(plugin.Path)))
            .Where(plugin => !MatchesLastWrite(modFolder, plugin))]));

        if (tracked[false].Any())
            notifications.Publish(new UntrackedPluginsNotification(origin, [.. tracked[false].Select(plugin => plugin.Name)]));
    }

    // Bytes that cannot be read, or a last write that cannot, match nothing (ADR-0003).
    private static bool MatchesLastWrite(string modFolder, ChangedPlugin plugin) =>
        plugin.BytesSha256 is { } observed
        && SourceRepository.ParkedCompileBinarySha256s(modFolder, plugin.Name)
            .Contains(observed, StringComparer.OrdinalIgnoreCase);
}
