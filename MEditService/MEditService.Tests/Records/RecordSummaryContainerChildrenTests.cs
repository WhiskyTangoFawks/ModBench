using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>
/// <see cref="RecordSummary.HasContainerChildren"/> is the Plugins-tree listing's own presence
/// fact (#560) — whether a row has at least one <c>container_child</c> child, computed inside
/// <see cref="IRecordReads.Search"/> itself (a second correlated EXISTS alongside the existing
/// <c>has_committed_snapshot</c> one; see <c>DuckDbRecordIndex.RelationReads.Search</c>), never a
/// per-row follow-up call. The Plugins tree's <c>RecordNode</c> collapsible state reads this flag
/// directly, so a Quest/DialogTopic row only shows an expand chevron when it actually has children.
/// </summary>
public sealed class RecordSummaryContainerChildrenTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);
    private static readonly PluginKey Key = new("Dialogue.esp", "Data");

    private static RecordSummary SummaryFor(PagedResult<RecordSummary> page, string formKey) =>
        page.Items.Single(i => i.FormKey == formKey);

    // One Quest with a DialogTopic child, one Quest with none — the exact AC1 fixture: the
    // listing must mark them true/false respectively, read from container_child rather than
    // guessed from the record's type signature alone.
    [Fact]
    public void Search_QuestWithChildren_ReportsHasContainerChildrenTrue_QuestWithoutReportsFalse()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Dialogue.esp"), Fallout4Release.Fallout4);
        var withChildren = mod.Quests.AddNew("QuestWithChildren");
        var topic = new DialogTopic(mod) { EditorID = "Topic0" };
        withChildren.DialogTopics.Add(topic);
        var withoutChildren = mod.Quests.AddNew("QuestWithoutChildren");

        using var index = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        index.Initialize(GameRelease.Fallout4);
        index.Index((IModGetter)mod, Registration.Participating(0), Key);
        index.UpdateWinners();

        var page = index.Search(new RecordQuery(Plugin: Key, RecordTypes: ["qust"], Limit: 50));

        Assert.True(SummaryFor(page, withChildren.FormKey.ToString()).HasContainerChildren);
        Assert.False(SummaryFor(page, withoutChildren.FormKey.ToString()).HasContainerChildren);
    }
}
