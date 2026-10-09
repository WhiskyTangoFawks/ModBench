using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>Real documents, with <see cref="Unreadable"/>'s record read as ingest reads one it could not
/// turn into its document.</summary>
internal sealed class DiagnosingAdapter() : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    public string? Unreadable { get; set; }

    public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null) =>
        base.OpenDocuments(modPath, gameRelease, schemas, strings).Map<IPluginDocuments, IPluginDocuments>(
            documents => new Diagnosed(documents, Unreadable));
}

file sealed class Diagnosed(IPluginDocuments inner, string? unreadable) : IPluginDocuments
{
    public PluginDocument Header => inner.Header;
    public IReadOnlyList<RecordTypeFailure> Failures => inner.Failures;

    public IEnumerable<PluginDocument> Records => inner.Records.Select(record =>
        record.FormKey == unreadable
            ? record with { Text = $"{{\"FormKey\": \"{record.FormKey}\"}}", ParseDiagnosis = "could not be read" }
            : record);

    public void Dispose() => inner.Dispose();
}
