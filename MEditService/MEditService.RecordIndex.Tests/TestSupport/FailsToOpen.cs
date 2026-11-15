using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Reads as the real adapter does, and answers <paramref name="failure"/> to each open of the documents
/// that <paramref name="atOpen"/> picks by its number.</summary>
internal sealed class FailsToOpen(PluginFailure failure, Func<int, bool> atOpen, Action? beforeFailing = null)
    : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    private int _opened;

    public bool Failed { get; private set; }

    public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings strings)
    {
        if (!atOpen(Interlocked.Increment(ref _opened))) return base.OpenDocuments(modPath, loadOrder, schemas, strings);
        beforeFailing?.Invoke();
        Failed = true;
        return failure;
    }
}
