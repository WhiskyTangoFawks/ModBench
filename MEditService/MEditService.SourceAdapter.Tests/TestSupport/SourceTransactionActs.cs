using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.TestSupport;

/// <summary>A repository's changes, applied through the transaction under test.</summary>
internal static class SourceTransactionActs
{
    internal static void Put(this SourceTransaction transaction, SourceRepository repository, PluginAddress plugin, SourceDocument document) =>
        transaction.Apply(repository.ChangesToPut(plugin, document));

    internal static void PutInWorldspace(
        this SourceTransaction transaction, SourceRepository repository, PluginAddress plugin, SourceDocument cell, string worldspace) =>
        transaction.Apply(repository.ChangesToPutInWorldspace(plugin, cell, worldspace));

    internal static void PutInWorldspace(this SourceRepository repository, PluginAddress plugin, SourceDocument cell, string worldspace) =>
        SourceTransaction.Atomically(repository, transaction => transaction.PutInWorldspace(repository, plugin, cell, worldspace));

    internal static void Rekey(
        this SourceTransaction transaction, SourceRepository repository, PluginAddress plugin, RecordIdentity identity, string newFormKey,
        DocumentRekey rekey) =>
        transaction.Apply(repository.ChangesToRekey(
            plugin, OwnerDocument(repository, plugin, identity), identity, newFormKey, rekey));

    private static SourceDocument OwnerDocument(
        SourceRepository repository, PluginAddress plugin, RecordIdentity identity)
    {
        var owner = identity;
        while (repository.ContainerOf(plugin, owner) is { } container)
            owner = repository.Get(plugin, container.ParentFormKey).Require().Identity;
        return repository.RecordOf(plugin, owner).Require();
    }
}
