using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Each compiled plugin changed outside Modbench (ADR-0003).</summary>
internal sealed class ExternalChangeCheck(INotificationPublisher notifications, IPluginAdapter adapter, ISourceAdapter source)
{
    private readonly Lock _checking = new();
    // A mod whose repository went since is told it names no changed plugin.
    private readonly HashSet<string> _compiledPluginAtLastCheck = new(StringComparer.Ordinal);

    /// <summary>Checks each mod that provides one of <paramref name="plugins"/>, whole: its answer names every changed plugin.</summary>
    public void Check(LoadOrderSnapshot snapshot, IEnumerable<RegisteredPlugin> plugins)
    {
        var checkedMods = plugins.Select(plugin => plugin.Provider).OfType<PluginProvider.FromMod>().ToHashSet();
        var mods = snapshot.Plugins
            .Where(plugin => plugin.Provider is PluginProvider.FromMod mod && checkedMods.Contains(mod))
            .GroupBy(plugin => (PluginProvider.FromMod)plugin.Provider);

        lock (_checking)
        {
            foreach (var mod in mods)
            {
                if (source.Open(mod.Key, snapshot.GameRelease) is { } repository)
                {
                    _compiledPluginAtLastCheck.Add(mod.Key.Folder);
                    Tell(mod.Key.Name, repository, [.. mod]);
                }
                else if (_compiledPluginAtLastCheck.Remove(mod.Key.Folder))
                {
                    notifications.Publish(new ExternalChangeNotification(mod.Key.Name, []));
                }
            }
        }
    }

    private void Tell(string origin, ISourceRepository repository, IReadOnlyList<RegisteredPlugin> plugins)
    {
        notifications.Publish(new ExternalChangeNotification(origin, [.. plugins
            .Where(plugin => source.SourceReads(plugin))
            .Select(plugin => (plugin.Key, Observed: adapter.HashOf(plugin.Path)))
            .Where(plugin => !MatchesLastWrite(repository, plugin.Key, plugin.Observed))
            .Select(plugin => new ChangedPlugin(plugin.Key.Name, plugin.Observed))]));
    }

    // Bytes that cannot be read, or a last write that cannot, match nothing (ADR-0003).
    private static bool MatchesLastWrite(ISourceRepository repository, PluginAddress plugin, string? observed) =>
        observed is not null
        && repository.LastWrittenBinarySha256s(plugin).Holds(out var written, out _)
        && written.Contains(observed, StringComparer.OrdinalIgnoreCase);
}
