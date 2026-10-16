using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Each source plugin changed outside Modbench (ADR-0003), and each source mod's
/// plugins whose plugin source is unreadable.</summary>
internal sealed class ExternalChangeCheck(INotificationPublisher notifications, IPluginAdapter adapter, ISourceAdapter source)
{
    private readonly Lock _checking = new();
    // A mod whose repository went since is told it names no changed plugin.
    private HashSet<string> _sourcePluginAtLastCheck = new(StringComparer.Ordinal);

    public void Check(LoadOrderSnapshot snapshot)
    {
        var mods = snapshot.Plugins
            .Where(plugin => plugin.Provider is PluginProvider.FromMod)
            .GroupBy(plugin => (PluginProvider.FromMod)plugin.Provider);

        lock (_checking)
        {
            var sourcePlugin = new HashSet<string>(StringComparer.Ordinal);
            foreach (var mod in mods)
            {
                if (source.Open(mod.Key, snapshot.GameRelease) is { } repository)
                {
                    sourcePlugin.Add(mod.Key.Folder);
                    Tell(mod.Key.Name, repository, [.. mod]);
                }
                else if (_sourcePluginAtLastCheck.Contains(mod.Key.Folder))
                {
                    notifications.Publish(new ExternalChangeNotification(mod.Key.Name, []));
                }
            }
            _sourcePluginAtLastCheck = sourcePlugin;
        }
    }

    private void Tell(string origin, ISourceRepository repository, IReadOnlyList<RegisteredPlugin> plugins)
    {
        var sourceReads = plugins.ToLookup(plugin => source.SourceReads(plugin));
        notifications.Publish(new ExternalChangeNotification(origin, [.. sourceReads[true]
            .Select(plugin => (plugin.Key, Observed: adapter.HashOf(plugin.Path)))
            .Where(plugin => !MatchesLastWrite(repository, plugin.Key, plugin.Observed))
            .Select(plugin => new ChangedPlugin(plugin.Key.Name, plugin.Observed))]));

        if (sourceReads[false].Any())
        {
            notifications.Publish(new PluginSourceUnreadableNotification(origin, [.. sourceReads[false]
                .SelectMany(plugin => source.WhySourceDoesNotRead(plugin) is { } why
                    ? new[] { new PluginWithUnreadableSource(plugin.Name, new UnreadableSource(why.Reason, why.DecompileRepairs)) }
                    : [])]));
        }
    }

    // Bytes that cannot be read, or a last write that cannot, match nothing (ADR-0003).
    internal static bool MatchesLastWrite(ISourceRepository repository, PluginAddress plugin, string? observed) =>
        observed is not null
        && repository.LastWrittenBinarySha256s(plugin).Holds(out var written, out _)
        && written.Contains(observed, StringComparer.OrdinalIgnoreCase);
}
