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

    private static readonly Dictionary<string, Func<IQueries, SmallBesideLarge, object?>> ReadsAboutOnePlugin = new()
    {
        ["records"] = (q, s) => q.GetRecords(null, s.Plugin, null, 100, 0).Value(),
        ["record types"] = (q, s) => q.GetPluginRecordTypes(s.Plugin).Value(),
        ["states beneath"] = (q, s) => q.GetWorkingTreeStatesBeneath(s.Plugin).Value(),
        ["child record types"] = (q, s) => q.GetChildRecordTypes(s.Plugin, s.Quest).Value(),
        ["rendered document"] = (q, s) => q.GetRenderedDocument(s.Plugin, s.Quest).Value(),
        ["copy document"] = (q, s) => q.GetCopyDocument(s.Plugin, s.Quest).Value(),
        ["worldspaces"] = (q, s) => q.GetWorldspaces(s.Plugin).Value(),
        ["worldspace blocks"] = (q, s) => q.GetWorldspaceBlocks(s.Plugin, s.Keys.Worldspace.ToString()).Value(),
        ["cell children"] = (q, s) => q.GetCellChildRecords(s.Plugin, s.Keys.EmbedCell.ToString()).Value(),
        ["interior cells"] = (q, s) => q.GetInteriorCells(s.Plugin).Value(),
        ["container children"] = (q, s) => q.GetContainerChildren(s.Plugin, s.Quest).Value(),
        ["dependants"] = (q, s) => q.GetDependants(s.Plugin).Value(),
    };

    public static TheoryData<string> Reads => [.. ReadsAboutOnePlugin.Keys];

    [Theory]
    [MemberData(nameof(Reads))]
    public void AReadAboutOnePlugin_Answers_InMemoryAnotherPluginsHoldingsOutgrow(string read) =>
        Assert.NotNull(ReadsAboutOnePlugin[read](shared.Index.Queries, shared));
}
