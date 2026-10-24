using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Opens every plugin as <paramref name="plugin"/>, holding NPCs made up rather than read, each
/// carrying the links <paramref name="records"/> gives it: as many as a test needs, at no cost of building a plugin.</summary>
internal sealed class LinkingAdapter(string plugin, Func<IEnumerable<(string FormKey, IEnumerable<string> Links)>> records)
    : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings strings) =>
        RequireExtensions.AnswerOf<IPluginDocuments>(() => new LinkingRecords(plugin, records));

    private sealed class LinkingRecords(string plugin, Func<IEnumerable<(string FormKey, IEnumerable<string> Links)>> records) : IPluginDocuments
    {
        public PluginDocument Header => new("header", $"000000:{plugin}", "{}");

        public IReadOnlyList<RecordTypeFailure> Failures => [];

        public IEnumerable<PluginDocument> Records => records().Select(record => new PluginDocument(
            "npc_", record.FormKey,
            $$"""{"FormKey": "{{record.FormKey}}", "Keywords": [{{string.Join(", ", record.Links.Select(link => $"\"{link}\""))}}]}"""));

        public void Dispose()
        {
        }
    }
}
