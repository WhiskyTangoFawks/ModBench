using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class WholeSetRefusalTests
{
    private static readonly PluginAddress Anywhere = new("First.esp", "SomeMod");

    private static readonly Dictionary<string, Func<IQueries, IndexRefused>> WholeSetQueries = new()
    {
        [nameof(IQueries.GetRecord)] = q => q.GetRecord("000800:First.esp").Refused(),
        [nameof(IQueries.GetCompareRecords)] = q => q.GetCompareRecords([new RecordCopy("000800:First.esp", Anywhere)]).Refused(),
        [nameof(IQueries.GetLoadOrderDiagnoses)] = q => q.GetLoadOrderDiagnoses().Refused(),
        [nameof(IQueries.GetDependants)] = q => q.GetDependants(Anywhere).Refused(),
        [nameof(IQueries.GetProblems)] = q => q.GetProblems().Refused(),
        [nameof(IQueries.SelectRows)] = q => q.SelectRows("SELECT form_key FROM npc_").Refused(),
        [nameof(IQueries.ResolveNames)] = q => q.ResolveNames([new NameQuery("Anything")]).Refused(),
    };

    private static readonly Dictionary<string, Func<IQueries, IndexRefused>> ReadsQueries = new()
    {
        [nameof(IQueries.GetPlugins)] = q => q.GetPlugins().Refused(),
        [nameof(IQueries.GetFilter)] = q => q.GetFilter().Refused(),
        [nameof(IQueries.SetFilter)] = q => q.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql")
            ?? throw new InvalidOperationException("Expected the Index to refuse here."),
        [nameof(IQueries.GetInteriorCells)] = q => q.GetInteriorCells(Anywhere).Refused(),
        [nameof(IQueries.GetContainerChildren)] = q => q.GetContainerChildren(Anywhere, "000800:First.esp").Refused(),
        [nameof(IQueries.GetCreatablePluginExtensions)] = q => q.GetCreatablePluginExtensions().Refused(),
    };

    public static TheoryData<string> Queries => [.. WholeSetQueries.Keys];

    public static TheoryData<string> EveryQuery => [.. WholeSetQueries.Keys, .. ReadsQueries.Keys];

    [Theory]
    [MemberData(nameof(EveryQuery))]
    public void WithNoLoadOrder_IsRefusedAsSuch(string query)
    {
        using var index = Indexes.Open(new LoadOrderHolder());

        var refused = (WholeSetQueries.GetValueOrDefault(query) ?? ReadsQueries[query])(index.Queries);

        Assert.Equal(IndexRefusal.NoLoadOrder, refused.Refusal);
        Assert.Contains("No load order", refused.Message);
    }

    [Theory]
    [MemberData(nameof(Queries))]
    public async Task WhileReconciling_IsNotReady_ForAPluginNotYetReachedHasNoRowsAndWouldReadAsAbsent(string query)
    {
        using var fixture = Fixture();
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter(gateBefore: "Later.esp");
        using var index = Indexes.Open(holder, gate);
        var load = Task.Run(() => index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        try
        {
            Assert.Equal(IndexRefusal.IndexNotReady, WholeSetQueries[query](index.Queries).Refusal);
        }
        finally
        {
            gate.Release();
            await load;
        }
    }

    [Theory]
    [MemberData(nameof(Queries))]
    public void WhenTheIndexFailed_IsNotReady_ForTheSetWasNeverRead(string query)
    {
        using var fixture = Fixture();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Oblivion);
        Assert.Equal(LoadOrderState.Failed, index.Status.State);

        Assert.Equal(IndexRefusal.IndexNotReady, WholeSetQueries[query](index.Queries).Refusal);
    }

    private static ScatteredFixtureData Fixture() =>
        new PluginFixtureBuilder("whole-set-refusal")
            .WithPlugin("First.esp", mod => mod.Npcs.AddNew("FirstNpc"))
            .WithPlugin("Later.esp")
            .BuildScattered();
}
