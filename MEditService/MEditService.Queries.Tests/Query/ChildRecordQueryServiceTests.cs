using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries.Tests.TestSupport;

namespace MEditService.Queries.Tests.Query;

public sealed class ChildRecordQueryServiceTests
{
    private static readonly PluginAddress Source = new("Source.esm", "SourceMod");
    private static readonly PluginAddress Holder = new("Holder.esp", "HolderMod");
    private static readonly PluginAddress Bare = new("Bare.esp", "BareMod");
    private static readonly PluginAddress NotAsked = new("NotAsked.esp", "NotAskedMod");

    private static readonly RecordAt Quest = new(Source, "000800:Source.esm");
    private static readonly RecordAt Npc = new(Source, "000801:Source.esm");

    private static (ChildRecordQueryService Service, FakeIndex Index) Over(LoadOrderState state = LoadOrderState.Ready)
    {
        var reads = new FakeReads(new Dictionary<PluginAddress, PluginContent>(), [])
        {
            RecordsWithChildren = new HashSet<RecordAt> { Quest },
            ChildHolders = new HashSet<PluginAddress>(PluginAddress.Comparer) { Holder, NotAsked },
        };
        var index = new FakeIndex(reads, new LoadOrderStatus(state, 0, 0, [], true, []));
        return (new ChildRecordQueryService(index), index);
    }

    [Fact]
    public void TheRecordsWithChildRecords_AreTheOnesTheIndexSaysHoldAny_InTheOrderAsked()
    {
        var (service, _) = Over();

        Assert.Equal([Quest], service.WithChildRecords([Npc, Quest]));
    }

    [Fact]
    public void TheHoldingDestinations_AreOnlyThoseAsked_PerRecord()
    {
        var (service, _) = Over();

        var answer = service.DestinationsHoldingChildRecords([Quest, Npc], [Holder, Bare]);

        Assert.Equal([Quest, Npc], answer.Select(a => a.Record));
        Assert.All(answer, a => Assert.Equal([Holder], a.Destinations));
    }

    [Theory]
    [InlineData(LoadOrderState.None)]
    [InlineData(LoadOrderState.Reconciling)]
    public void TheHoldingDestinations_AreNotAnswered_UntilEveryPluginIsIndexed(LoadOrderState state)
    {
        var (service, _) = Over(state);

        Assert.Throws<NoLoadOrderException>(() => service.DestinationsHoldingChildRecords([Quest], [Holder]));
    }
}
