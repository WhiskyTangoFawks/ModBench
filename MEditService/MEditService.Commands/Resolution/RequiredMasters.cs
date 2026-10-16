using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Resolution;

/// <summary>The masters a plugin's content requires (ADR-0008), gathered one document at a
/// time, with the links that require them.</summary>
internal sealed class RequiredMasters(PluginAddress plugin)
{
    private readonly HashSet<string> _masters = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _links = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The masters <paramref name="plugin"/>'s working tree requires (ADR-0008).</summary>
    internal static Answer<IReadOnlySet<string>, SourceFailure> InTheTree(
        ISourceRepository repository, PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        repository.ReadDocuments(plugin, documents =>
        {
            var required = new RequiredMasters(plugin);
            foreach (var document in documents.Records) required.Add(document, schemas[document.RecordType]);
            return required.Masters;
        });

    internal IReadOnlySet<string> Masters => _masters;

    internal IReadOnlyCollection<string> Links => _links;

    internal void Add(PluginDocument document, RecordTableSchema schema)
    {
        var links = FormReferences.Collect(document.Text, schema.RecordColumns).ConvertAll(reference => reference.TargetFormKey);
        _links.UnionWith(links);
        _masters.UnionWith(RecordMasters.Of(plugin.Name, document.FormKey, links));
    }
}
