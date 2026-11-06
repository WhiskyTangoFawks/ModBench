using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The plugins of a load order whose plugin source a change follows into.</summary>
internal static class PluginSources
{
    /// <summary>Each plugin of a source mod whose source reads, with its mod, and each whose source does not read, left
    /// behind with why.</summary>
    internal static (IReadOnlyList<(RegisteredPlugin Plugin, PluginProvider.FromMod Mod)> Reading, List<SourceLeftBehind> Unread) Of(
        ISourceAdapter source, LoadOrderSnapshot loadOrder)
    {
        var reading = new List<(RegisteredPlugin, PluginProvider.FromMod)>();
        var unread = new List<SourceLeftBehind>();
        foreach (var plugin in loadOrder.Plugins.Where(source.IsSourceMod))
        {
            if (plugin.Provider is not PluginProvider.FromMod mod) continue;
            if (source.SourceReads(plugin)) reading.Add((plugin, mod));
            else if (source.WhySourceDoesNotRead(plugin) is { } why and not SourceFailure.NotCarried) unread.Add(new(plugin.Key, why.Reason));
        }
        return (reading, unread);
    }
}
