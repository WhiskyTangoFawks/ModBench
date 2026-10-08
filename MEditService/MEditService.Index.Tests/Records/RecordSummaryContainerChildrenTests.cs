using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class RecordSummaryContainerChildrenTests
{
    private static readonly PluginAddress Key = new("Dialogue.esp", PluginOrigin.DataDirectory);

    private static RecordSummary SummaryFor(PagedResult<RecordSummary> page, string formKey) =>
        page.Items.Single(i => i.FormKey == formKey);

    [Fact]
    public void Search_QuestWithChildren_ReportsHasContainerChildrenTrue_QuestWithoutReportsFalse()
    {
        FormKey withChildren = default, withoutChildren = default;
        using var fixture = new PluginFixtureBuilder("container-children")
            .WithPlugin(Key.Name, mod =>
            {
                var quest = mod.Quests.AddNew("QuestWithChildren");
                quest.DialogTopics.Add(new DialogTopic(mod) { EditorID = "Topic0" });
                withChildren = quest.FormKey;
                withoutChildren = mod.Quests.AddNew("QuestWithoutChildren").FormKey;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var page = index.Records.GetRecords(["qust"], Key, search: null, limit: 50, offset: 0);

        Assert.True(SummaryFor(page, withChildren.ToString()).HasContainerChildren);
        Assert.False(SummaryFor(page, withoutChildren.ToString()).HasContainerChildren);
    }

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

        var page = index.Records.GetRecords(["qust"], plugin: null, search: "QuestWithChildren", limit: 50, offset: 0);

        Assert.True(SummaryFor(page, quest.ToString()).HasContainerChildren);
    }
}
