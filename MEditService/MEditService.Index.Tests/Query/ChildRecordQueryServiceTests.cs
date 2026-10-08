using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.Query;

public sealed class ChildRecordQueryServiceTests : IDisposable
{
    private static readonly PluginAddress Source = new("Source.esm", "SourceMod");
    private static readonly PluginAddress Holder = new("Holder.esp", "HolderMod");
    private static readonly PluginAddress Bare = new("Bare.esp", "BareMod");
    private static readonly PluginAddress NotAsked = new("NotAsked.esp", "NotAskedMod");

    private readonly ScatteredFixtureData _fixture;
    private readonly RecordAt _quest;
    private readonly RecordAt _npc;

    public ChildRecordQueryServiceTests()
    {
        string quest = "", npc = "";
        _fixture = new PluginFixtureBuilder("child-record-query")
            .WithPlugin(Source.Name, mod =>
            {
                var topicHolder = new Quest(mod) { EditorID = "TopicHolder" };
                topicHolder.DialogTopics.Add(new DialogTopic(mod) { EditorID = "HeldTopic" });
                mod.Quests.Add(topicHolder);
                quest = topicHolder.FormKey.ToString();
                npc = mod.Npcs.AddNew("Childless").FormKey.ToString();
            }, origin: Source.Origin)
            .WithPlugin(Holder.Name, (mod, built) => mod.Quests.Add(built[0].Quests.Single().DeepCopy()), origin: Holder.Origin)
            .WithPlugin(Bare.Name, (mod, built) => mod.Npcs.Add(built[0].Npcs.Single().DeepCopy()), origin: Bare.Origin)
            .WithPlugin(NotAsked.Name, (mod, built) => mod.Quests.Add(built[0].Quests.Single().DeepCopy()), origin: NotAsked.Origin)
            .BuildScattered();
        _quest = new RecordAt(Source, quest);
        _npc = new RecordAt(Source, npc);
    }

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void TheRecordsWithChildRecords_AreTheOnesTheIndexSaysHoldAny_InTheOrderAsked()
    {
        using var index = Indexes.Reconciled(_fixture);

        Assert.Equal([_quest], index.ChildRecords.WithChildRecords([_npc, _quest]));
    }

    [Fact]
    public void TheHoldingDestinations_AreOnlyThoseAsked_PerRecord()
    {
        using var index = Indexes.Reconciled(_fixture);

        var answer = index.ChildRecords.DestinationsHoldingChildRecords([_quest, _npc], [Holder, Bare]);

        Assert.Equal([_quest, _npc], answer.Select(a => a.Record));
        Assert.Equal<PluginAddress>([Holder], answer[0].Destinations);
        Assert.Empty(answer[1].Destinations);
    }

    [Fact]
    public void TheHoldingDestinations_AreNotAnswered_BeforeALoadOrderArrives()
    {
        using var index = Indexes.Open(new LoadOrderHolder());

        Assert.Throws<NoLoadOrderException>(() => index.ChildRecords.DestinationsHoldingChildRecords([_quest], [Holder]));
    }

    [Fact]
    public async Task TheHoldingDestinations_AreNotAnswered_UntilEveryPluginIsIndexed()
    {
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter(gateBefore: NotAsked.Name);
        using var index = Indexes.Open(holder, gate);
        var load = Task.Run(() => index.Reconcile(holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        Assert.Throws<NoLoadOrderException>(() => index.ChildRecords.DestinationsHoldingChildRecords([_quest], [Holder]));

        gate.Release();
        await load;
    }
}
