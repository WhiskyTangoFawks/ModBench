using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Real documents, with <see cref="Unreadable"/>'s record read as ingest reads one it could not
/// turn into its document, and <see cref="FailedRecordType"/> a type whose enumeration failed.</summary>
internal sealed class DiagnosingAdapter() : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    public string? Unreadable { get; set; }

    public string? FailedRecordType { get; set; }

    public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings strings) =>
        base.OpenDocuments(modPath, loadOrder, schemas, strings).Map<IPluginDocuments, IPluginDocuments>(
            documents => new Diagnosed(documents, Unreadable, FailedRecordType));
}

file sealed class Diagnosed(IPluginDocuments inner, string? unreadable, string? failedRecordType) : IPluginDocuments
{
    public PluginDocument Header => inner.Header;
    public IReadOnlyList<RecordTypeFailure> Failures =>
        failedRecordType is null ? inner.Failures : [.. inner.Failures, new RecordTypeFailure(failedRecordType, "could not be enumerated")];

    public IEnumerable<PluginDocument> Records => inner.Records.Select(record =>
        record.FormKey == unreadable
            ? record with { Text = $"{{\"FormKey\": \"{record.FormKey}\"}}", ParseDiagnosis = "could not be read" }
            : record);

    public void Dispose() => inner.Dispose();
}
