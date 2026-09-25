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
        this IPluginAdapter adapter, RegisteredPlugin copy, GameRelease release,
        IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        adapter.OpenRecordLookup(new ModPath(copy.Path), release, schemas);

    public static bool CanRead(this IPluginAdapter adapter, RegisteredPlugin copy) =>
        adapter.CanRead(new ModPath(ModKey.FromFileName(copy.Name), copy.Path));

    /// <summary>The files the game loads, one winning copy per filename in slot order, with
    /// <paramref name="compiled"/> among them however it is registered (ADR-0013).</summary>
    public static LinkAnswers LinkTargets(
        this IPluginAdapter adapter, LoadOrderSnapshot loadOrder, RegisteredPlugin compiled,
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

    /// <summary>The source-tree door for a caller holding the load order's record of the copy.
    /// Building the mod path is building a Mutagen value, and this is the box that owns those
    /// (ADR-0005 rule 2).</summary>
    public static Task<(IReadOnlyList<TreeFile> Files, string? MissingStringsFile)> ReadSourceOfAsync(
        this IPluginAdapter adapter, RegisteredPlugin copy, GameRelease gameRelease, PluginStrings strings,
        CancellationToken cancel = default) =>
        adapter.ReadSourceAsync(
            new ModPath(ModKey.FromFileName(copy.Name), copy.Path), copy.Name, gameRelease, strings, cancel);

    /// <summary>How the plugin at <paramref name="recompiledPath"/> differs from the one whose file
    /// name and path are named here, for a caller that holds neither a copy nor a mod path.</summary>
    public static string? DivergenceFrom(
        this IPluginAdapter adapter, string pluginFileName, string pluginFilePath, string recompiledPath,
        GameRelease gameRelease, PluginStrings strings) =>
        adapter.DivergenceBetween(
            new ModPath(ModKey.FromFileName(pluginFileName), pluginFilePath), recompiledPath, gameRelease,
            strings);

    private static bool SameFile(RegisteredPlugin copy, RegisteredPlugin other) =>
        copy.Name.Equals(other.Name, StringComparison.OrdinalIgnoreCase);
}
