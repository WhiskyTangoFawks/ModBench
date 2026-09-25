using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

/// <summary>Computed inside <see cref="IRecordReads.Search"/> as a correlated EXISTS, never a
/// per-row follow-up call; the Plugins tree's collapsible state reads this flag directly.</summary>
public sealed class RecordSummaryContainerChildrenTests
{
    private static readonly PluginAddress Key = new("Dialogue.esp", "Data");

    private static RecordSummary SummaryFor(PagedResult<RecordSummary> page, string formKey) =>
        page.Items.Single(i => i.FormKey == formKey);

    // One Quest with a DialogTopic child, one Quest with none — the exact AC1 fixture: the
    // listing must mark them true/false respectively, read from container_child rather than
    // guessed from the record's type signature alone.
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

        var page = index.RequireReads().Search(new RecordQuery(Plugin: Key.Name, Origin: Key.Origin, RecordTypes: ["qust"], Limit: 50));

        Assert.True(SummaryFor(page, withChildren.ToString()).HasContainerChildren);
        Assert.False(SummaryFor(page, withoutChildren.ToString()).HasContainerChildren);
    }
}
