using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter;

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

    /// <summary>The files the game loads, one winning copy per filename in slot order, with
    /// <paramref name="compiled"/> among them however it is registered (ADR-0013).</summary>
    public static LinkAnswers LinkTargets(
        this IPluginAdapter adapter, LoadOrderSnapshot loadOrder, RegisteredCopy compiled,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, IReadOnlyCollection<string> formKeys)
    {
        // One mod per filename, because that is what a link cache can hold: the copy being compiled
        // stands in for its own filename, at whatever slot the load order gives that name.
        var files = loadOrder.Participating
            .Select(copy => SameFile(copy, compiled) ? compiled : copy)
            .Append(compiled)
            .DistinctBy(copy => copy.Name, StringComparer.OrdinalIgnoreCase)
            .Select(copy => new ModPath(copy.Path))
            .ToList();
        return adapter.LinkTargets(files, loadOrder.GameRelease, schemas, formKeys);
    }

    private static bool SameFile(RegisteredCopy copy, RegisteredCopy other) =>
        copy.Name.Equals(other.Name, StringComparison.OrdinalIgnoreCase);

    public static bool LinksTo(
        this IPluginAdapter adapter, RegisteredCopy copy, GameRelease release, FormKey target, FormKey? itself) =>
        adapter.LinksTo(new ModPath(copy.Path), release, target, itself);
}
