using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Schema;

/// <summary>The masters a record requires (ADR-0008): each plugin its FormKey and its links name, other
/// than the plugin holding it. A FormKey names a plugin by file name alone (ADR-0012).</summary>
public static class RecordMasters
{
    /// <summary>Each master once, spelled as first named.</summary>
    public static List<string> Of(string pluginFileName, string formKey, IEnumerable<string> links) =>
        [.. links.Prepend(formKey)
            .Select(PluginNamedBy)
            .OfType<string>()
            .Where(master => !master.Equals(pluginFileName, StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase)];

    /// <summary>The plugin <paramref name="formKey"/> names, by Mutagen's own parse: a FormKey's spelling is
    /// its definition. Null and None name no plugin, and neither does text that is no FormKey.</summary>
    public static string? PluginNamedBy(string formKey) =>
        FormKey.TryFactory(formKey, out var parsed) && !parsed.IsNull ? parsed.ModKey.FileName.String : null;
}
