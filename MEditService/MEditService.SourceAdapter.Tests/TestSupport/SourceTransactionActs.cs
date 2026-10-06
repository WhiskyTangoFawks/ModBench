using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.TestSupport;

/// <summary>A repository's changes, applied through the transaction under test.</summary>
internal static class SourceTransactionActs
{
    internal static void Put(this SourceTransaction transaction, SourceRepository repository, PluginAddress plugin, SourceDocument document) =>
        transaction.Apply(repository, repository.ChangesToPut(plugin, document));

    internal static void PutInWorldspace(
        this SourceTransaction transaction, SourceRepository repository, PluginAddress plugin, SourceDocument cell, string worldspace) =>
        transaction.Apply(repository, repository.ChangesToPutInWorldspace(plugin, cell, worldspace));

    internal static void Rekey(
        this SourceTransaction transaction, SourceRepository repository, PluginAddress plugin, RecordIdentity identity, string newFormKey,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, DocumentRekey rekey) =>
        transaction.Apply(repository, repository.ChangesToRekey(
            plugin, repository.ContainerDocument(plugin, identity, schemas).Require(), identity, newFormKey, rekey));
}
