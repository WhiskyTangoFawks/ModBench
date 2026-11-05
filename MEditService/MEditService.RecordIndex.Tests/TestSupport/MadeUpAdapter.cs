using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>As <see cref="LinkingAdapter"/>, for each plugin <paramref name="plugins"/> names, holding the documents its
/// generator gives. Any other plugin is read.</summary>
internal sealed class MadeUpAdapter(params (string Plugin, Func<IEnumerable<PluginDocument>> Records)[] plugins)
    : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    private readonly Dictionary<string, Func<IEnumerable<PluginDocument>>> _records =
        plugins.ToDictionary(p => p.Plugin, p => p.Records, StringComparer.OrdinalIgnoreCase);

    public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings strings) =>
        _records.TryGetValue(modPath.ModKey.FileName, out var records)
            ? RequireExtensions.AnswerOf<IPluginDocuments>(() => new MadeUpRecords(modPath.ModKey.FileName, records))
            : base.OpenDocuments(modPath, loadOrder, schemas, strings);

    private sealed class MadeUpRecords(string plugin, Func<IEnumerable<PluginDocument>> records) : IPluginDocuments
    {
        public PluginDocument Header => new("header", $"000000:{plugin}", "{}");

        public IReadOnlyList<RecordTypeFailure> Failures => [];

        public IEnumerable<PluginDocument> Records => records();

        public void Dispose()
        {
        }
    }
}
