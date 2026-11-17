using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

internal static class HandedPlugins
{
    /// <summary>Each plugin whose tree holds a path, with those paths and the <paramref name="written"/> documents among
    /// them. Null when a path names no plugin, so only a check of the whole disk reads it.</summary>
    internal static List<HandedPlugin>? Naming(
        ISourceAdapter source, LoadOrderSnapshot loadOrder, IEnumerable<string> paths, IReadOnlyList<WrittenDocument> written)
    {
        var files = new Dictionary<PluginAddress, List<string>>(PluginAddress.Comparer);
        foreach (var path in paths)
        {
            switch (source.Touching(loadOrder, path))
            {
                case PathAnswer.Unnamed: return null;
                case PathAnswer.Touches touches:
                    foreach (var plugin in touches.Plugins.Select(plugin => plugin.Key))
                    {
                        if (files.TryGetValue(plugin, out var named)) named.Add(path);
                        else files[plugin] = [path];
                    }
                    break;
            }
        }
        return [.. files.Select(named => new HandedPlugin(
            named.Key, named.Value, [.. written.Where(document => named.Value.Contains(document.Path, StringComparer.Ordinal))]))];
    }
}
