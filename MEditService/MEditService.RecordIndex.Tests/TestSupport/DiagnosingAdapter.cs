using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Real documents, read as ingest reads a plugin some of whose records it could not read.</summary>
internal sealed class DiagnosingAdapter() : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    /// <summary>The record read as one ingest could not turn into its document.</summary>
    public string? Unreadable { get; set; }

    /// <summary>The record type whose enumeration failed.</summary>
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
