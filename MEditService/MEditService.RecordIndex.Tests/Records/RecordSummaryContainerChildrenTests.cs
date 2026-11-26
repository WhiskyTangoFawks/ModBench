using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class RecordSummaryContainerChildrenTests
{
    private static readonly PluginAddress Key = new("Dialogue.esp", PluginOrigin.DataDirectory);

    private static RecordSummary SummaryFor(PagedResult<RecordSummary> page, string formKey) =>
        page.Items.Single(i => i.FormKey == formKey);

    [Fact]
    public void ASearch_ReportsChildrenTheRecordFilterHides()
    {
        FormKey quest = default;
        using var fixture = new PluginFixtureBuilder("container-children-search")
            .WithPlugin(Key.Name, mod =>
            {
                var withChildren = mod.Quests.AddNew("QuestWithChildren");
                withChildren.DialogTopics.Add(new DialogTopic(mod) { EditorID = "Topic0" });
                quest = withChildren.FormKey;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        index.SetFilter($"SELECT '{quest}' AS form_key", "filter.sql");

        var page = index.Queries.GetRecords(["qust"], plugin: null, search: "QuestWithChildren", limit: 50, offset: 0).Value();

        Assert.True(SummaryFor(page, quest.ToString()).HasContainerChildren);
    }
}
