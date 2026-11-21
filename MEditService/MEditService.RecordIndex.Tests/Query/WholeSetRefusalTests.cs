using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class WholeSetRefusalTests
{
    private static readonly PluginAddress FirstPlugin = new("First.esp", PluginOrigin.DataDirectory);

    private static readonly Dictionary<string, Func<IQueries, IndexRefused>> BehindTheWholeSetGuard = new()
    {
        [nameof(IQueries.GetRecordOwners)] = q => q.GetRecordOwners(["000800:First.esp"]).Refused(),
        [nameof(IQueries.GetRecordOwnersForAWrite)] = q => q.GetRecordOwnersForAWrite(1, ["000800:First.esp"]).Refused(),
        [nameof(IQueries.GetCompareRecords)] = q => q.GetCompareRecords([new RecordCopy("000800:First.esp", FirstPlugin)]).Refused(),
        [nameof(IQueries.GetCopyStates)] = q => q.GetCopyStates(["000800:First.esp"], plugin: null).Refused(),
        [nameof(IQueries.GetPlacedReferences)] = q => q.GetPlacedReferences("000800:First.esp").Refused(),
        [nameof(IQueries.GetLoadOrderDiagnoses)] = q => q.GetLoadOrderDiagnoses().Refused(),
        [nameof(IQueries.GetDependants)] = q => q.GetDependants(FirstPlugin).Refused(),
        [nameof(IQueries.GetProblems)] = q => q.GetProblems().Refused(),
        [nameof(IQueries.GetFilePaths)] = q => q.GetFilePaths(null).Refused(),
        [nameof(IQueries.SelectRows)] = q => q.SelectRows("SELECT form_key FROM npc_").Refused(),
        [nameof(IQueries.ResolveNames)] = q => q.ResolveNames([new NameQuery("Anything")]).Refused(),
    };

    private static readonly Dictionary<string, Func<IQueries, IndexRefused>> BehindTheReadsGuard = new()
    {
        [nameof(IQueries.GetPlugins)] = q => q.GetPlugins().Refused(),
        [nameof(IQueries.GetPluginsIndexing)] = q => q.GetPluginsIndexing().Refused(),
        [nameof(IQueries.GetFilter)] = q => q.GetFilter().Refused(),
        [nameof(IQueries.SetFilter)] = q => q.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql")
            ?? throw new InvalidOperationException("Expected the Index to refuse here."),
        [nameof(IQueries.GetInteriorCells)] = q => q.GetInteriorCells(FirstPlugin).Refused(),
        [nameof(IQueries.GetContainerChildren)] = q => q.GetContainerChildren(FirstPlugin, "000800:First.esp").Refused(),
        [nameof(IQueries.GetCreatablePluginExtensions)] = q => q.GetCreatablePluginExtensions().Refused(),
        [nameof(IQueries.GetCreatablePluginFlags)] = q => q.GetCreatablePluginFlags("Any.esp").Refused(),
    };

    private static readonly Dictionary<string, Func<IQueries, IndexRefused>> BehindAGuard =
        BehindTheWholeSetGuard.Concat(BehindTheReadsGuard).ToDictionary();

    public static TheoryData<string> WholeSetGuard => [.. BehindTheWholeSetGuard.Keys];

    public static TheoryData<string> EveryGuard => [.. BehindAGuard.Keys];

    [Theory]
    [MemberData(nameof(EveryGuard))]
    public void WithNoLoadOrder_IsRefused_ForThereIsNothingToRead(string query)
    {
        using var index = Indexes.Open(new LoadOrderHolder());

        var refused = BehindAGuard[query](index.Queries);

        Assert.Equal(IndexRefusal.NoLoadOrder, refused.Refusal);
        Assert.Contains("No load order", refused.Message);
    }

    [Fact]
    public async Task WhileReconciling_AWholeSetReadAnswersWithWhatTheIndexHolds()
    {
        using var fixture = Fixture();
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter(gateBefore: "Later.esp");
        using var index = Indexes.Open(holder, gate);
        var load = Task.Run(() => index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        try
        {
            Assert.Equal(LoadOrderState.Reconciling, index.Status.State);
            Assert.Equal("FirstNpc", Assert.Single(index.Queries.Selected("SELECT editor_id FROM npc_")).GetProperty("editor_id").GetString());
        }
        finally
        {
            gate.Release();
            await load;
        }
    }

    [Fact]
    public async Task WhileTheFirstReadFills_TheOwnersForAWrite_AreNotReady_ForNoCopyHasYetBeenDecidedTheWinner()
    {
        using var fixture = Fixture();
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter(gateBefore: "Later.esp");
        using var index = Indexes.Open(holder, gate);
        var load = Task.Run(() => index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        try
        {
            Assert.Equal(IndexRefusal.IndexNotReady, index.Queries.GetRecordOwnersForAWrite(Held(holder), [FirstNpc(index)]).Refused().Refusal);
        }
        finally
        {
            gate.Release();
            await load;
        }
    }

    [Fact]
    public async Task WhileAReconcileOverARead_HasNotDecidedItsWinners_TheOwnersForAWrite_AreNotReady_AndAreOnceItHas()
    {
        using var fixture = Fixture();
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter(gateBefore: "Later.esp");
        using var index = Indexes.Open(holder, gate);
        index.Reconcile(holder, fixture.DataFolder, [.. fixture.Plugins.Where(plugin => plugin.Name != "Later.esp")], GameRelease.Fallout4);
        var npc = FirstNpc(index);
        var load = Task.Run(() => index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        IndexRefusal midway;
        try
        {
            midway = index.Queries.GetRecordOwnersForAWrite(Held(holder), [npc]).Refused().Refusal;
        }
        finally
        {
            gate.Release();
            await load;
        }

        Assert.Equal(IndexRefusal.IndexNotReady, midway);
        Assert.Equal([FirstPlugin], index.Queries.GetRecordOwnersForAWrite(Held(holder), [npc]).Value()[npc]);
    }

    [Fact]
    public void OnReady_TheOwnersForAWrite_OfAnotherLoadOrder_AreNotReady_AndOfTheOneHeld_AreTheWinners()
    {
        using var fixture = Fixture();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);
        var npc = FirstNpc(index);

        Assert.Equal(IndexRefusal.IndexNotReady, index.Queries.GetRecordOwnersForAWrite(Held(holder) + 1, [npc]).Refused().Refusal);
        Assert.Equal([FirstPlugin], index.Queries.GetRecordOwnersForAWrite(Held(holder), [npc]).Value()[npc]);
    }

    [Fact]
    public async Task WhileARebuildRefillsTheLoadOrderHeld_TheOwnersForAWriteOfIt_AreNotReady()
    {
        using var fixture = Fixture();
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, gate);
        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4, fixture.InstanceRoot);
        var npc = FirstNpc(index);
        gate.ParkNextOpenOf("Later.esp");

        Assert.Null(index.Queries.RebuildStore(GameRelease.Fallout4, fixture.InstanceRoot));
        await gate.WaitUntilParkedAsync();

        try
        {
            Assert.Equal(IndexRefusal.IndexNotReady, index.Queries.GetRecordOwnersForAWrite(Held(holder), [npc]).Refused().Refusal);
        }
        finally
        {
            gate.Release();
            Waits.Reached(() => index.Status.State == LoadOrderState.Ready, "the refill");
        }
    }

    [Fact]
    public async Task WhileAReReadLandsAPlugin_TheOwnersForAWrite_WaitForItsWinners()
    {
        using var fixture = Fixture();
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, gate);
        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);
        var npc = FirstNpc(index);
        var later = fixture.Plugins.Single(plugin => plugin.Name == "Later.esp");
        gate.ParkNextOpenOf(later.Name);
        PluginBinaries.Rewrite(later.Path, mod => mod.Npcs.Add(new Npc(FormKey.Factory(npc), Fallout4Release.Fallout4) { EditorID = "Overridden" }));
        index.SignalChange([later.Key]);
        await gate.WaitUntilParkedAsync();

        var asked = Task.Run(() => index.Queries.GetRecordOwnersForAWrite(Held(holder), [npc]));
        var answeredWhileParked = Waits.ReachedWithin(() => asked.IsCompleted, TimeSpan.FromSeconds(1));
        gate.Release();

        Assert.False(answeredWhileParked);
        Assert.Equal([later.Key], (await asked).Value()[npc]);
    }

    private static long Held(LoadOrderHolder holder) => holder.Held.Require().Version;

    private static string FirstNpc(OpenedIndex index) =>
        Assert.Single(index.Queries.Selected("SELECT form_key FROM npc_")).GetProperty("form_key").GetString().Require();

    [Theory]
    [MemberData(nameof(WholeSetGuard))]
    public void WhenTheIndexFailed_IsNotReady_ForTheSetWasNeverRead(string query)
    {
        using var fixture = Fixture();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Oblivion);
        Assert.Equal(LoadOrderState.Failed, index.Status.State);

        Assert.Equal(IndexRefusal.IndexNotReady, BehindTheWholeSetGuard[query](index.Queries).Refusal);
    }

    private static ScatteredFixtureData Fixture() =>
        new PluginFixtureBuilder("whole-set-refusal")
            .WithPlugin("First.esp", mod => mod.Npcs.AddNew("FirstNpc"))
            .WithPlugin("Later.esp")
            .BuildScattered();
}
