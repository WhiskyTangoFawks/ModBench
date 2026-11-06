using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The plugin sources a change to a plugin's records follows into.</summary>
internal static class PluginSources
{
    /// <summary>Each plugin source naming <paramref name="plugin"/>'s records: its own, and, when mod order resolves its
    /// file name to it, each of another file name (ADR-0012). One that does not read is left behind, with why.</summary>
    internal static (IReadOnlyList<(RegisteredPlugin Plugin, PluginProvider.FromMod Mod)> Reading, List<SourceLeftBehind> Unread) Naming(
        ISourceAdapter source, LoadOrderSnapshot loadOrder, RegisteredPlugin plugin)
    {
        var resolved = loadOrder.ReadsTheGamesStrings(plugin.Path);
        bool Names(RegisteredPlugin other) =>
            PluginAddress.Comparer.Equals(other.Key, plugin.Key) || (resolved && !other.Name.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase));

        var reading = new List<(RegisteredPlugin, PluginProvider.FromMod)>();
        var unread = new List<SourceLeftBehind>();
        foreach (var other in loadOrder.Plugins.Where(other => Names(other) && source.IsSourceMod(other)))
        {
            if (other.Provider is not PluginProvider.FromMod mod) continue;
            if (source.SourceReads(other)) reading.Add((other, mod));
            else if (source.WhySourceDoesNotRead(other) is { } why and not SourceFailure.NotCarried) unread.Add(new(other.Key, why.Reason));
        }
        return (reading, unread);
    }
}
