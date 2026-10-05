using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>The masters a plugin's content requires (ADR-0008), gathered one document at a
/// time, with the links that require them.</summary>
internal sealed class RequiredMasters(PluginAddress plugin)
{
    private readonly HashSet<string> _masters = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _links = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The masters <paramref name="plugin"/>'s working tree requires (ADR-0008).</summary>
    /// <remarks>An unreadable tree refuses, with nothing written. <paramref name="comesFromTheMasters"/>
    /// names what the caller reads from a master of the plugin.</remarks>
    internal static RecordEditResult? InTheTree(
        SourceRepository repository, PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string spelled, string comesFromTheMasters, out IReadOnlySet<string> masters)
    {
        var required = new RequiredMasters(plugin);
        try
        {
            using var documents = repository.OpenDocuments(plugin, schemas);
            foreach (var document in documents.Records) required.Add(document, schemas[document.RecordType]);
        }
        catch (UnreadableSourceDocumentException ex)
        {
            masters = required.Masters;
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.RecordParseFailed, spelled,
                $"'{spelled}': {comesFromTheMasters} comes only from a master of {plugin.Name}, " +
                $"which its source tree names, and that tree cannot be read: {ex.Message.TrimEnd('.')}. Nothing was written.");
        }
        masters = required.Masters;
        return null;
    }

    internal IReadOnlySet<string> Masters => _masters;

    internal IReadOnlyCollection<string> Links => _links;

    internal void Add(PluginDocument document, RecordTableSchema schema)
    {
        // An override carries another plugin's FormKey, which needs that plugin as a master
        // whether or not the record references anything.
        Require(document.FormKey);

        using var parsed = JsonDocument.Parse(document.Text);
        foreach (var target in FormReferences.Collect(parsed.RootElement, schema).Select(reference => reference.TargetFormKey))
        {
            _links.Add(target);
            Require(target);
        }
    }

    // The plugin half of a FormKey, which is how a reference names the master it needs. Mutagen's
    // own parser, not a split on the colon: a FormKey's spelling is its definition.
    internal static string? PluginNameIn(string formKey) =>
        FormKey.TryFactory(formKey, out var parsed) ? parsed.ModKey.FileName.String : null;

    private void Require(string formKey)
    {
        if (PluginNameIn(formKey) is { } master && !master.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
            _masters.Add(master);
    }
}
