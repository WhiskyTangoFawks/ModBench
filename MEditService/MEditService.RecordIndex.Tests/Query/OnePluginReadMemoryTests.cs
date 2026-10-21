using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class OnePluginReadMemoryTests(OnePluginReadMemoryTests.SmallBesideLarge shared)
    : IClassFixture<OnePluginReadMemoryTests.SmallBesideLarge>
{
    private const string Small = "Small.esp";
    private const string Large = "Large.esp";
    private const int LargeQuests = 100;
    private const int TopicsPerQuest = 2_000;
    private const string MemoryLimit = "32MB";

    public sealed class SmallBesideLarge : IDisposable
    {
        private readonly PluginFixtureData _fixture;

        internal OpenedIndex Index { get; }
        internal PluginAddress Plugin { get; } = new(Small, PluginOrigin.DataDirectory);
        internal ContainerModPlugin.Keys Keys { get; }
        internal string Quest { get; }

        public SmallBesideLarge()
        {
            ContainerModPlugin.Keys keys = default;
            var quest = "";
            _fixture = new PluginFixtureBuilder("one-plugin-read-memory")
                .WithPlugin(Small, mod =>
                {
                    keys = ContainerModPlugin.AddTo(mod);
                    var held = new Quest(mod) { EditorID = "SmallQuest" };
                    held.DialogTopics.Add(new DialogTopic(mod) { EditorID = "SmallTopic" });
                    mod.Quests.Add(held);
                    quest = held.FormKey.ToString();
                })
                .WithPlugin(Large)
                .Build();
            Keys = keys;
            Quest = quest;
            Index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new HoldingAdapter(Large, LargeQuests, TopicsPerQuest));
            IndexFiles.LimitMemory(_fixture.InstanceRoot, MemoryLimit);
        }

        public void Dispose()
        {
            Index.Dispose();
            _fixture.Dispose();
        }
    }

    private static readonly Dictionary<string, Action<IQueries, SmallBesideLarge>> ReadsAboutOnePlugin = new()
    {
        ["records"] = (q, s) => Assert.Contains("SmallQuest", q.GetRecords(null, s.Plugin, null, 100, 0).Value().Items.Select(r => r.EditorId)),
        ["record types"] = (q, s) => Assert.Contains("qust", q.GetPluginRecordTypes(s.Plugin).Value().Select(t => t.Type)),
        ["states beneath"] = (q, s) => Assert.Empty(q.GetWorkingTreeStatesBeneath(s.Plugin).Value().Plugin),
        ["child record types"] = (q, s) => Assert.Contains("dial", (q.GetChildRecordTypes(s.Plugin, s.Quest).Value() ?? []).Select(t => t.Type)),
        ["rendered document"] = (q, s) => Assert.Contains("SmallQuest", q.GetRenderedDocument(s.Plugin, s.Quest).Value()?.Text),
        ["copy document"] = (q, s) => Assert.Equal(CopyDocumentKind.Rendered, q.GetCopyDocument(s.Plugin, s.Quest).Value()?.Kind),
        ["worldspaces"] = (q, s) => Assert.Equal([ContainerModPlugin.WorldspaceEditorId], q.GetWorldspaces(s.Plugin).Value().Select(w => w.EditorId)),
        ["worldspace blocks"] = (q, s) => Assert.Equal(
            [ContainerModPlugin.TopCellEditorId], q.GetWorldspaceBlocks(s.Plugin, s.Keys.Worldspace.ToString()).Value().TopCells.Select(c => c.EditorId)),
        ["cell children"] = (q, s) => Assert.Equal(
            [ContainerModPlugin.PersistentRefEditorId], q.GetCellChildRecords(s.Plugin, s.Keys.EmbedCell.ToString()).Value().Persistent.Select(c => c.EditorId)),
        ["interior cells"] = (q, s) => Assert.Contains(
            ContainerModPlugin.EmbedCellEditorId,
            q.GetInteriorCells(s.Plugin).Value().SelectMany(b => b.SubBlocks).SelectMany(sb => sb.Cells).Select(c => c.EditorId)),
        ["container children"] = (q, s) => Assert.Equal(["SmallTopic"], q.GetContainerChildren(s.Plugin, s.Quest).Value().Select(c => c.EditorId)),
        ["dependants"] = (q, s) => Assert.Empty(q.GetDependants(s.Plugin).Value().Dependants),
    };

    public static TheoryData<string> Reads => [.. ReadsAboutOnePlugin.Keys];

    [Theory]
    [MemberData(nameof(Reads))]
    public void AReadAboutOnePlugin_Answers_InMemoryAnotherPluginsHoldingsOutgrow(string read) =>
        ReadsAboutOnePlugin[read](shared.Index.Queries, shared);
}
