using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>The real adapter reading a binary without the schema tables <paramref name="dropped"/>
/// names: it reads one table at a time, so a record type with no table never becomes a document.</summary>
internal sealed class AdapterReadingWithoutTables(Func<string, bool> dropped) : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings strings) =>
        base.OpenDocuments(modPath, loadOrder, schemas.Where(table => !dropped(table.Key)).ToDictionary(), strings);
}
