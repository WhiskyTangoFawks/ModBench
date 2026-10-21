using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Opens <paramref name="plugin"/> as quests made up rather than read, each holding
/// <paramref name="topicsPerQuest"/> topics: as many holdings as a test needs, at no cost of building a
/// plugin. Every other plugin reads as it is.</summary>
internal sealed class HoldingAdapter(string plugin, int quests, int topicsPerQuest)
    : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null) =>
        string.Equals(modPath.ModKey.FileName, plugin, StringComparison.OrdinalIgnoreCase)
            ? RequireExtensions.AnswerOf<IPluginDocuments>(() => new HoldingRecords(plugin, quests, topicsPerQuest))
            : base.OpenDocuments(modPath, loadOrder, schemas, strings);

    private sealed class HoldingRecords(string plugin, int quests, int topicsPerQuest) : IPluginDocuments
    {
        public PluginDocument Header => new("header", $"000000:{plugin}", "{}");

        public IReadOnlyList<RecordTypeFailure> Failures => [];

        public IEnumerable<PluginDocument> Records => Enumerable.Range(0, quests).SelectMany(quest =>
        {
            var questKey = FormKeyAt(quest * (topicsPerQuest + 1));
            var topics = Enumerable.Range(1, topicsPerQuest)
                .Select(topic => new PluginDocument("dial", FormKeyAt(quest * (topicsPerQuest + 1) + topic), $$"""{"FormKey": "{{FormKeyAt(quest * (topicsPerQuest + 1) + topic)}}"}"""))
                .ToList();
            var held = string.Join(", ", topics.Select(topic => topic.Text));
            return topics.Prepend(new PluginDocument("qust", questKey, $$"""{"FormKey": "{{questKey}}", "DialogTopics": [{{held}}]}"""));
        });

        private string FormKeyAt(int i) => $"{0x800 + i:X6}:{plugin}";

        public void Dispose()
        {
        }
    }
}
