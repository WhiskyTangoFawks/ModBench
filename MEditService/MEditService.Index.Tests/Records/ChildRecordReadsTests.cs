using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Index.Tests.Records;

public sealed class ChildRecordReadsTests : IDisposable
{
    private static readonly PluginAddress Source = new("Source.esm", "SourceMod");
    private static readonly PluginAddress QuestParentOnly = new("QuestParentOnly.esp", "QuestParentOnlyMod");
    private static readonly PluginAddress QuestResponseOnly = new("QuestResponseOnly.esp", "QuestResponseOnlyMod");
    private static readonly PluginAddress QuestTopic = new("QuestTopic.esp", "QuestTopicMod");
    private static readonly PluginAddress WorldspaceParentOnly = new("WorldspaceParentOnly.esp", "WorldspaceParentOnlyMod");
    private static readonly PluginAddress WorldspaceWhole = new("WorldspaceWhole.esp", "WorldspaceWholeMod");
    private static readonly PluginAddress Unrelated = new("Unrelated.esp", "UnrelatedMod");
    private static readonly PluginAddress TwinWithParentOnly = new("Twin.esp", "TwinParentOnlyMod");
    private static readonly PluginAddress TwinWithTopic = new("Twin.esp", "TwinTopicMod");

    private readonly ScatteredFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly string _quest;
    private readonly string _loneQuest;
    private readonly string _npc;
    private readonly string _worldspace;
    private readonly string _cell;
    private readonly string _topic;

    public ChildRecordReadsTests()
    {
        FormKey quest = default, loneQuest = default, npc = default, worldspace = default, cell = default, topic = default;
        _fixture = new PluginFixtureBuilder("child-record-reads")
            .WithPlugin(Source.Name, mod =>
            {
                var q = mod.Quests.AddNew("Quest");
                var t = new DialogTopic(mod) { EditorID = "Topic" };
                t.Responses.Add(new DialogResponses(mod) { EditorID = "Response" });
                q.DialogTopics.Add(t);
                loneQuest = mod.Quests.AddNew("LoneQuest").FormKey;
                npc = mod.Npcs.AddNew("Npc").FormKey;

                var w = mod.Worldspaces.AddNew("World");
                var c = new Cell(mod) { EditorID = "Cell", Grid = new CellGrid { Point = new P2Int(0, 0) } };
                c.Persistent.Add(new PlacedObject(mod) { EditorID = "Ref" });
                var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                subBlock.Items.Add(c);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(subBlock);
                w.SubCells.Add(block);

                (quest, topic, worldspace, cell) = (q.FormKey, t.FormKey, w.FormKey, c.FormKey);
            }, origin: Source.Origin)
            .WithPlugin(QuestParentOnly.Name, (mod, built) => OverrideQuest(mod, built, withTopics: false), origin: QuestParentOnly.Origin)
            .WithPlugin(QuestResponseOnly.Name, (mod, built) =>
            {
                var response = built[0].Quests.Single(q => q.EditorID == "Quest").DialogTopics.Single().Responses.Single();
                var movedTopic = new DialogTopic(mod) { EditorID = "MovedTopic" };
                movedTopic.Responses.Add(new DialogResponses(response.FormKey, Fallout4Release.Fallout4));
                OverrideQuest(mod, built, withTopics: false).DialogTopics.Add(movedTopic);
            }, origin: QuestResponseOnly.Origin)
            .WithPlugin(QuestTopic.Name, (mod, built) => OverrideQuest(mod, built, withTopics: true), origin: QuestTopic.Origin)
            .WithPlugin(
                WorldspaceParentOnly.Name,
                (mod, built) => mod.Worldspaces.GetOrAddAsOverride(built[0].Worldspaces.Single()).SubCells.Clear(),
                origin: WorldspaceParentOnly.Origin)
            .WithPlugin(
                WorldspaceWhole.Name,
                (mod, built) =>
                {
                    var sourceWorldspace = built[0].Worldspaces.Single();
                    mod.Worldspaces.GetOrAddAsOverride(sourceWorldspace).SubCells.AddRange(sourceWorldspace.SubCells.Select(b => b.DeepCopy()));
                },
                origin: WorldspaceWhole.Origin)
            .WithPlugin(Unrelated.Name, mod => mod.Npcs.AddNew("UnrelatedNpc"), origin: Unrelated.Origin)
            .WithPlugin(TwinWithParentOnly.Name, (mod, built) => OverrideQuest(mod, built, withTopics: false), origin: TwinWithParentOnly.Origin)
            .WithPlugin(TwinWithTopic.Name, (mod, built) => OverrideQuest(mod, built, withTopics: true), origin: TwinWithTopic.Origin)
            .BuildScattered();
        (_quest, _loneQuest, _npc, _worldspace, _cell, _topic) =
            (quest.ToString(), loneQuest.ToString(), npc.ToString(), worldspace.ToString(), cell.ToString(), topic.ToString());
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static Quest OverrideQuest(Fallout4Mod mod, IReadOnlyList<Fallout4Mod> built, bool withTopics)
    {
        var quest = mod.Quests.GetOrAddAsOverride(built[0].Quests.Single(q => q.EditorID == "Quest"));
        if (!withTopics) quest.DialogTopics.Clear();
        return quest;
    }

    private IRecordReads Reads => _index.RequireReads();

    [Fact]
    public void ARecordHasChildRecords_WhenItsPluginHoldsAnyBelowIt()
    {
        Assert.True(Reads.HasChildRecords(Source, _quest));
        Assert.True(Reads.HasChildRecords(Source, _topic));
        Assert.True(Reads.HasChildRecords(Source, _worldspace));
        Assert.True(Reads.HasChildRecords(Source, _cell));
        Assert.False(Reads.HasChildRecords(Source, _loneQuest));
        Assert.False(Reads.HasChildRecords(Source, _npc));
    }

    [Fact]
    public void ARecordHasNoChildRecords_InAPluginThatHoldsOnlyTheRecordItself()
    {
        Assert.False(Reads.HasChildRecords(QuestParentOnly, _quest));
        Assert.True(Reads.HasChildRecords(QuestTopic, _quest));
    }

    [Fact]
    public void ThePluginsHoldingAQuestsChildRecords_AreThoseHoldingAnyOfThemAtAnyDepth()
    {
        var holders = Reads.PluginsHoldingChildRecords(Source, _quest);

        Assert.True(holders.SetEquals([Source, QuestResponseOnly, QuestTopic, TwinWithTopic]));
    }

    [Fact]
    public void ThePluginsHoldingAWorldspacesChildRecords_AreThoseHoldingAnyCellOrReferenceBelowIt()
    {
        var holders = Reads.PluginsHoldingChildRecords(Source, _worldspace);

        Assert.True(holders.SetEquals([Source, WorldspaceWhole]));
    }

    [Fact]
    public void ARecordWithNoChildRecords_HasNoPluginsHoldingThem()
    {
        Assert.Empty(Reads.PluginsHoldingChildRecords(Source, _loneQuest));
    }

    [Fact]
    public void TwoPluginsOfOneFilename_AreToldApartByOrigin()
    {
        var holders = Reads.PluginsHoldingChildRecords(Source, _quest);

        Assert.Contains(TwinWithTopic, holders);
        Assert.DoesNotContain(TwinWithParentOnly, holders);
    }
}
