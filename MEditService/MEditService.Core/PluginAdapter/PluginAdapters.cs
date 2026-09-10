using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.PluginAdapter;

/// <summary>The adapter's doors onto one registered copy's own bytes, for a caller holding the load
/// order's record of where that copy is rather than a path.</summary>
public static class PluginAdapters
{
    public static IPluginRecordLookup OpenRecordLookup(
        this IPluginAdapter adapter, RegisteredCopy copy, GameRelease release,
        IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        adapter.OpenRecordLookup(new ModPath(copy.Path), release, schemas);

    public static PluginFormIds ReadFormIds(this IPluginAdapter adapter, RegisteredCopy copy, GameRelease release) =>
        adapter.ReadFormIds(new ModPath(copy.Path), release);

    public static bool LinksTo(
        this IPluginAdapter adapter, RegisteredCopy copy, GameRelease release, FormKey target, FormKey? itself) =>
        adapter.LinksTo(new ModPath(copy.Path), release, target, itself);
}
