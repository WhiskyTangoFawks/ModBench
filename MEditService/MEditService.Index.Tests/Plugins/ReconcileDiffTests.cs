using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Plugins;

public sealed class ReconcileDiffTests
{
    private static (OpenedIndex Index, GatedPluginAdapter Opens) MakeIndex(LoadOrderHolder holder)
    {
        var opens = new GatedPluginAdapter();
        return (Indexes.Open(holder, opens), opens);
    }

    private static ScatteredFixtureData TwoProviders(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("A.esm", mod => mod.Npcs.AddNew("SharedNPC"))
            .WithPlugin("B.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("A.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .BuildScattered();

    private static IRecordReads ReadsOf(OpenedIndex index) =>
        index.RequireReads();

    private static RecordOverrides OverrideStackOf(OpenedIndex index, string formKey) =>
        ReadsOf(index).GetOverrideStack(formKey)
            ?? throw new InvalidOperationException($"Expected an override stack for '{formKey}'.");

    private static string SharedNpc(OpenedIndex index) =>
        ReadsOf(index)
            .Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Plugin: "A.esm", Limit: 10, Offset: 0))
            .Items.Single().FormKey;

    private static string? WinnerOf(OpenedIndex index, string formKey) =>
        OverrideStackOf(index, formKey).Entries.Single(e => e.IsWinner).Plugin.Name;

    private static IReadOnlyList<(string FormKey, string? Body)> Bodies(IReadOnlyList<RecordDocument> documents) =>
        [.. documents.Select(d => (d.FormKey, d.Body))];

    private static IReadOnlyList<LoadOrderEntry> With(IReadOnlyList<LoadOrderEntry> plugins, string name, Func<LoadOrderEntry, LoadOrderEntry> change) =>
        plugins.Select(p => p.Name == name ? change(p) : p).ToList();

    [Fact]
    public void IdenticalSnapshotTwice_SecondIsANoOp_NoSweepNoProgress()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-noop");
        var notifications = new InMemoryNotificationPublisher();
        var opens = new GatedPluginAdapter();
        using var _ = opens;
        using var index = Indexes.Open(holder, opens, notifications: notifications);
        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var statusAfterFirst = index.Status;
        Assert.True(statusAfterFirst.ConflictsComputed);
        var patch = fx.Plugins.Single(p => p.Name == "B.esp");

        var announced = index.AnnouncedByEqualArrivals(notifications, () => Announcements.Touched(patch));

        Assert.All(announced, n => Assert.True(Announcements.PluginChanged(patch)(n)));
        Assert.Equal(2, opens.Opened.Count(name => name == "B.esp") - 1);
        Assert.Equal(1, opens.Opened.Count(name => name == "A.esm"));
        Assert.Equal(statusAfterFirst.IndexedPlugins, index.Status.IndexedPlugins);
        Assert.Equal(statusAfterFirst.State, index.Status.State);
    }

    [Fact]
    public void Reorder_OpensNoPlugin_AndWinnersFollowTheNewOrder()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-reorder");
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;
        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var npc = SharedNpc(index);
        Assert.Equal("B.esp", WinnerOf(index, npc));
        var opened = opens.OpenedTotal;
        var sequence = index.Sequence;
        var aKey = new PluginAddress("A.esm", fx.Plugins.Single(p => p.Name == "A.esm").Origin);
        var bKey = new PluginAddress("B.esp", fx.Plugins.Single(p => p.Name == "B.esp").Origin);
        var bodiesBefore = (A: Bodies(ReadsOf(index).DocumentsOf(aKey)), B: Bodies(ReadsOf(index).DocumentsOf(bKey)));

        var swapped = fx.Plugins.Select(p => p with { Slot = p.Name == "A.esm" ? 1 : 0 }).ToList();
        index.Reconcile(holder, fx.GameDirectory, swapped, GameRelease.Fallout4);

        Assert.Equal(opened, opens.OpenedTotal);
        Assert.Equal("A.esm", WinnerOf(index, npc));
        Assert.True(index.Sequence > sequence, "a reorder is a sweep, and a sweep is a projection");
        Assert.Equal(bodiesBefore.A, Bodies(ReadsOf(index).DocumentsOf(aKey)));
        Assert.Equal(bodiesBefore.B, Bodies(ReadsOf(index).DocumentsOf(bKey)));
    }

    [Fact]
    public void Disable_OpensNoPlugin_TheDisabledPluginIsReadNowhere_AndTheOtherProviderWins()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-disable");
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;
        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var npc = SharedNpc(index);
        var opened = opens.OpenedTotal;
        var bKey = new PluginAddress("B.esp", fx.Plugins.Single(p => p.Name == "B.esp").Origin);

        index.Reconcile(holder, fx.GameDirectory, With(fx.Plugins, "B.esp", p => p with { Enabled = false }), GameRelease.Fallout4);

        Assert.Equal(opened, opens.OpenedTotal);
        Assert.Empty(ReadsOf(index).DocumentsOf(bKey));
        Assert.Contains(bKey, ReadsOf(index).OpenedPlugins.Keys);
        Assert.Equal("A.esm", WinnerOf(index, npc));

        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        Assert.Equal(opened, opens.OpenedTotal);
        Assert.Equal("B.esp", WinnerOf(index, npc));
    }

    [Fact]
    public void OverriddenPlugin_IsHeldBesideTheWinner_NeverWins_AndReprioritisingFlipsTheWinnerWithoutOpeningAPlugin()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("reconcile-losing")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB"), origin: "ModB")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
        var snapshot = fx.Plugins;
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;

        index.Reconcile(holder, fx.GameDirectory, snapshot, GameRelease.Fallout4);

        var modA = new PluginAddress("Shared.esp", "ModA");
        var modB = new PluginAddress("Shared.esp", "ModB");
        var only = Assert.Single(OverrideStackOf(index, "000800:Shared.esp").Entries);
        Assert.Equal(modA, only.Plugin);
        Assert.True(only.IsWinner);
        Assert.Contains(index.RequireReads().OpenedPlugins.Keys, k => k.Equals(modB));

        var opened = opens.OpenedTotal;
        var flipped = snapshot.Select(p => p with { Winning = p.Origin == "ModB" }).ToList();
        index.Reconcile(holder, fx.GameDirectory, flipped, GameRelease.Fallout4);
        only = Assert.Single(OverrideStackOf(index, "000800:Shared.esp").Entries);
        Assert.Equal(modB, only.Plugin);
        Assert.True(only.IsWinner);
        Assert.Equal(opened, opens.OpenedTotal);
    }

    [Fact]
    public void PluginAbsentFromSnapshot_IsUnregistered_AndReturnsWithoutAReindex()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-leave");
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;
        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var npc = SharedNpc(index);
        var opened = opens.OpenedTotal;
        var bKey = new PluginAddress("B.esp", fx.Plugins.Single(p => p.Name == "B.esp").Origin);

        index.Reconcile(holder, fx.GameDirectory, fx.Plugins.Where(p => p.Name != "B.esp").ToList(), GameRelease.Fallout4);

        var readsAfterLeaving = ReadsOf(index);
        Assert.DoesNotContain(readsAfterLeaving.OpenedPlugins.Keys, k => k.Name == "B.esp");
        Assert.Empty(readsAfterLeaving.DocumentsOf(bKey));
        Assert.DoesNotContain(index.Status.IndexedPlugins, p => p.Name == "B.esp");
        Assert.Equal("A.esm", WinnerOf(index, npc));

        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.Equal(opened, opens.OpenedTotal);
        Assert.Contains(ReadsOf(index).OpenedPlugins.Keys, k => k.Name == "B.esp");
        Assert.Equal("B.esp", WinnerOf(index, npc));
    }

    [Fact]
    public void AfterRestart_IdenticalSnapshot_ReindexesNothing_AndADifferentOne_CorrectsTheRegistrations()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-restart");
        var (first, firstOpens) = MakeIndex(holder);
        using (first)
        using (firstOpens)
        {
            first.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4, fx.InstanceRoot);
        }

        var (second, opens) = MakeIndex(holder);
        using (second)
        using (opens)
        {
            second.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4, fx.InstanceRoot);

            Assert.Equal(0, opens.OpenedTotal);
            Assert.Equal("B.esp", WinnerOf(second, SharedNpc(second)));
            Assert.Equal(fx.Plugins.Count, second.Status.IndexedPlugins.Count);
        }

        var (third, thirdOpens) = MakeIndex(holder);
        using (third)
        using (thirdOpens)
        {
            third.Reconcile(holder, fx.GameDirectory, fx.Plugins.Where(p => p.Name != "B.esp").ToList(), GameRelease.Fallout4, fx.InstanceRoot);

            Assert.Equal(0, thirdOpens.OpenedTotal);
            Assert.Empty(ReadsOf(third).DocumentsOf(new PluginAddress("B.esp", fx.Plugins.Single(p => p.Name == "B.esp").Origin)));
            Assert.Equal("A.esm", WinnerOf(third, SharedNpc(third)));
        }
    }

    [Fact]
    public void FailedPlugin_IsAFailureOnTheRow_AnEqualSnapshotRunsNoSweep_AndRecoversOnceItsBytesChange()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("reconcile-failed").WithPlugin("Good.esp").BuildScattered();
        var badPath = Path.Combine(fx.Root, "Bad.esp");
        File.WriteAllBytes(badPath, [0xDE, 0xAD, 0xBE, 0xEF]);
        var snapshot = fx.Plugins.Append(new LoadOrderEntry("Bad.esp", badPath, "BadMod", 1, Enabled: true, Winning: true)).ToList();
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;

        index.Reconcile(holder, fx.GameDirectory, snapshot, GameRelease.Fallout4);

        Assert.Contains(index.Status.Failures, f => f.Name == "Bad.esp");
        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.DoesNotContain(ReadsOf(index).OpenedPlugins.Keys, k => k.Name == "Bad.esp");

        var sequence = index.Sequence;
        PluginBinaries.Touch(fx.Plugins[0].Path);
        index.NextSnapshot();
        Assert.Equal(sequence + 1, index.Sequence);

        new Fallout4Mod(ModKey.FromFileName("Bad.esp"), Fallout4Release.Fallout4).WriteToBinary(badPath);
        index.NextSnapshotUntil(() => index.Status.Failures.Count == 0, "the status without the recovered plugin's failure");

        Assert.Contains(ReadsOf(index).OpenedPlugins.Keys, k => k.Name == "Bad.esp");
    }

    [Fact]
    public void ADifferentInstance_ReplacesTheStore()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-other-instance");
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;
        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4, fx.InstanceRoot);
        var first = index.RequireReads();
        var otherInstance = Directory.CreateDirectory(Path.Combine(fx.Root, "other-instance")).FullName;

        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4, otherInstance);

        Assert.NotSame(first, index.RequireReads());
        Assert.Equal(otherInstance, holder.Current.InstanceRoot);
    }
}
