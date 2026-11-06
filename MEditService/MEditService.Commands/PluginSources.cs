using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The plugin sources a change to a plugin's records follows into.</summary>
internal static class PluginSources
{
    /// <summary>Each plugin source naming <paramref name="plugin"/>'s records, as the load order says. One that does not
    /// read is left behind, with why.</summary>
    internal static (IReadOnlyList<(RegisteredPlugin Plugin, PluginProvider.FromMod Mod)> Reading, List<SourceLeftBehind> Unread) Naming(
        ISourceAdapter source, LoadOrderSnapshot loadOrder, PluginAddress plugin)
    {
        var reading = new List<(RegisteredPlugin, PluginProvider.FromMod)>();
        var unread = new List<SourceLeftBehind>();
        foreach (var other in loadOrder.Plugins.Where(other => loadOrder.NamesRecordsOf(plugin, other.Key) && source.IsSourceMod(other)))
        {
            if (other.Provider is not PluginProvider.FromMod mod) continue;
            if (source.SourceReads(other)) reading.Add((other, mod));
            else if (source.WhySourceDoesNotRead(other) is { } why and not SourceFailure.NotCarried) unread.Add(new(other.Key, why.Reason));
        }
        return (reading, unread);
    }
}
