using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Edits;

/// <summary>What the watcher calls when a mod settles or loads (ADR-0003 invariant 3): each tracked
/// plugin's bytes against what Modbench last wrote, and the untracked plugins; none for an untracked
/// mod. It keeps and refuses nothing.</summary>
public sealed class TrackedModSettled
{
    private readonly INotificationPublisher _notifications;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every handler.
    internal TrackedModSettled(INotificationPublisher notifications) => _notifications = notifications;

    public void Handle(LoadOrderSnapshot loadOrder, string modFolder)
    {
        var plugins = loadOrder.Plugins
            .Where(plugin => string.Equals(
                LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path), modFolder, StringComparison.Ordinal))
            .ToList();
        // The origin is the mod manager's name for the mod, which only a plugin of it carries.
        if (plugins is not [{ Origin: var origin }, ..]) return;

        if (!SourceRepository.IsTracked(modFolder))
        {
            _notifications.Publish(new ExternalChangeNotification(origin, []));
            return;
        }

        var tracked = plugins.ToLookup(plugin => SourceRepository.IsPluginTracked(modFolder, plugin.Name));
        _notifications.Publish(new ExternalChangeNotification(origin, [.. tracked[true]
            .Select(plugin => new ChangedPlugin(plugin.Name, PluginBinaryHash.OfFile(plugin.Path)))
            .Where(plugin => !MatchesLastWrite(modFolder, plugin))]));

        if (tracked[false].Any())
            _notifications.Publish(new UntrackedPluginsNotification(origin, [.. tracked[false].Select(plugin => plugin.Name)]));
    }

    // Bytes that cannot be read, or a last write that cannot, match nothing (ADR-0003).
    private static bool MatchesLastWrite(string modFolder, ChangedPlugin plugin) =>
        plugin.BytesSha256 is { } observed
        && SourceRepository.ParkedCompileBinarySha256s(modFolder, plugin.Name)
            .Contains(observed, StringComparer.OrdinalIgnoreCase);
}
