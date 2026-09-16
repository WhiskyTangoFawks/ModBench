using System.Collections.Concurrent;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>ADR-0015 invariant 3 and ADR-0013 invariant 4, at the Index's own seam: a load order value in,
/// registrations and one sequence advance out, over a real DuckDB.</summary>
public sealed class IndexProjectorTests
{
    private static IndexProjector MakeProjector(LoadOrderHolder holder) => Indexes.Open(holder);

    private static (IndexProjector Projector, GatedPluginAdapter Opens) MakeCountingProjector(LoadOrderHolder holder)
    {
        var opens = new GatedPluginAdapter();
        return (Indexes.Open(holder, opens), opens);
    }

    // A.esm defines SharedNPC; B.esp overrides it — the two-provider stack the winner assertions read.
    private static ScatteredFixtureData TwoProviders(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("A.esm", mod => mod.Npcs.AddNew("SharedNPC"))
            .WithPlugin("B.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("A.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .BuildScattered();

    private static LoadOrderSnapshot Snapshot(ScatteredFixtureData fx, IReadOnlyList<LoadOrderEntry>? plugins = null) =>
        new LoadOrderSnapshot(fx.GameDirectory, fx.InstanceRoot, GameRelease.Fallout4, SnapshotCopies.Of(plugins ?? fx.Plugins));

    // The load-order endpoint's order: the value lands in the kernel, then the Index reconciles it.
    private static void Reconcile(IndexProjector projector, LoadOrderHolder holder, LoadOrderSnapshot snapshot)
    {
        holder.Apply(snapshot);
        projector.Reconcile(snapshot);
    }

    private static string SharedNpc(IndexProjector projector) =>
        projector.RequireReads()
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "A.esm", Limit: 10, Offset: 0))
            .Items.Single().FormKey;

    private static string? WinnerOf(IndexProjector projector, string formKey)
    {
        var stack = projector.RequireReads().GetOverrideStack(formKey)
            ?? throw new InvalidOperationException($"Expected {formKey} to resolve to an override stack.");
        return stack.Entries.Single(e => e.IsWinner).Plugin.Name;
    }

    // ADR-0013 invariant 4: the sweep is handed the kernel's load order. The holder alone takes the
    // next snapshot here, so the copies the Index has open still carry the old winner: a projector
    // reading them answers B.esp.
    [Fact]
    public async Task ASweepBetweenSnapshots_TakesItsWinnersFromTheHolder_NotFromTheCopiesItHasOpen()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-winners-from-holder");
        var projector = MakeProjector(holder);
        using var _1 = projector;
        Reconcile(projector, holder, Snapshot(fx));
        var npc = SharedNpc(projector);
        Assert.Equal("B.esp", WinnerOf(projector, npc));

        var b = fx.Plugins.Single(p => p.Name == "B.esp");
        holder.Apply(Snapshot(fx, [.. fx.Plugins.Select(p => p.Name == "B.esp" ? p with { Winning = false } : p)]));
        await projector.ReindexPlugin(new PluginCopyKey("B.esp", b.Origin));

        Assert.Equal("A.esm", WinnerOf(projector, npc));
    }

    [Fact]
    public void Reconcile_RegistersExactlyTheLoadOrdersCopies()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-registrations");
        var projector = MakeProjector(holder);
        using var _1 = projector;
        var snapshot = Snapshot(fx);

        Reconcile(projector, holder, snapshot);

        Assert.All(snapshot.Copies, copy => Assert.True(projector.Registers(copy.Key)));
        Assert.Equal(
            snapshot.Copies.Select(c => c.Key).OrderBy(k => k.Name, StringComparer.Ordinal),
            projector.RequireReads().OpenedCopies.Keys.OrderBy(k => k.Name, StringComparer.Ordinal));
        Assert.False(projector.Registers(new PluginCopyKey("Nobody.esp", PluginOrigin.DataDirectory)));
    }

    // Header flags, the master list and the record count are read out of the file when the copy is
    // opened and are stored in no row, so the reads answer them from the copies the Index holds open.
    [Fact]
    public void TheReads_CarryTheContentFactsOfEveryCopyTheIndexOpened()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-opened-content");
        var projector = MakeProjector(holder);
        using var _1 = projector;
        var snapshot = Snapshot(fx);

        Reconcile(projector, holder, snapshot);

        var opened = projector.RequireReads().OpenedCopies;
        var patch = opened[snapshot.Copies.Single(c => c.Name == "B.esp").Key];
        Assert.Equal(["A.esm"], patch.Masters);
        Assert.Equal(1, patch.RecordCount);
        Assert.False(patch.IsMaster);
        Assert.True(opened[snapshot.Copies.Single(c => c.Name == "A.esm").Key].IsMaster);
    }

    // A copy the Index could not open has no content to report, and the plugin listing is built by
    // joining the load order's copies to exactly this set.
    [Fact]
    public void TheReads_OmitACopyTheIndexCouldNotOpen()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-unopenable-content");
        var projector = MakeProjector(holder);
        using var _1 = projector;
        var gone = new LoadOrderEntry("Gone.esp", Path.Combine(fx.GameDirectory, "Gone.esp"), "SomeMod", 9, true, true);
        var snapshot = Snapshot(fx, [.. fx.Plugins, gone]);

        Reconcile(projector, holder, snapshot);

        var opened = projector.RequireReads().OpenedCopies;
        Assert.DoesNotContain(new PluginCopyKey("Gone.esp", "SomeMod"), opened.Keys);
        Assert.Contains(snapshot.Copies.Single(c => c.Name == "A.esm").Key, opened.Keys);
    }

    [Fact]
    public void ACopyDroppedFromTheSnapshot_LosesItsRegistration_OnTheNextReconcile()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-registrations-drop");
        var projector = MakeProjector(holder);
        using var _1 = projector;
        Reconcile(projector, holder, Snapshot(fx));
        var b = fx.Plugins.Single(p => p.Name == "B.esp");

        var withoutB = fx.Plugins.Where(p => p.Name != "B.esp").ToList();
        Reconcile(projector, holder, Snapshot(fx, withoutB));

        Assert.False(projector.Registers(new PluginCopyKey("B.esp", b.Origin)));
        Assert.True(projector.Registers(new PluginCopyKey("A.esm", fx.Plugins.Single(p => p.Name == "A.esm").Origin)));
    }

    [Fact]
    public void ACopyThatStopsParticipating_LosesItsWinners_OnTheNextReconcile_WithNoPluginReopened()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-stops-participating");
        var (projector, opens) = MakeCountingProjector(holder);
        using var _1 = projector;
        using var _2 = opens;
        Reconcile(projector, holder, Snapshot(fx));
        var npc = SharedNpc(projector);
        Assert.Equal("B.esp", WinnerOf(projector, npc));
        var opened = opens.OpenedTotal;

        var bDisabled = fx.Plugins.Select(p => p.Name == "B.esp" ? p with { Enabled = false } : p).ToList();
        Reconcile(projector, holder, Snapshot(fx, bDisabled));

        Assert.Equal("A.esm", WinnerOf(projector, npc));
        Assert.Equal(opened, opens.OpenedTotal);
    }

    [Fact]
    public void AnIdenticalSnapshot_IsANoOp_BySequence()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-identical");
        var projector = MakeProjector(holder);
        using var _1 = projector;
        Reconcile(projector, holder, Snapshot(fx));
        var settled = projector.Sequence;

        Reconcile(projector, holder, Snapshot(fx));

        Assert.Equal(settled, projector.Sequence);
    }

    [Fact]
    public async Task AWholePluginProjection_AdvancesTheSequenceExactlyOnce()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-one-advance");
        var projector = MakeProjector(holder);
        using var _1 = projector;
        Reconcile(projector, holder, Snapshot(fx));
        var before = projector.Sequence;

        await projector.ReindexPlugin(new PluginCopyKey("B.esp", PluginOrigin.DataDirectory));

        Assert.Equal(before + 1, projector.Sequence);
    }

    [Fact]
    public async Task ATrackedCopyReDerivedFromADirtyTree_AdvancesTheSequenceExactlyOnce()
    {
        using var fixture = IndexedModFixture.Tracked();
        var index = (IndexProjector)fixture.Index;
        // Dirty, so the head reconcile has baselines to write: a clean tree short-circuits it and
        // would leave the multi-advance case untested.
        var text = File.ReadAllText(fixture.NpcSourceFile);
        File.WriteAllText(fixture.NpcSourceFile, text.Replace(
            $"\"{IndexedModFixture.NpcEditorId}\"", "\"RenamedByHand\"", StringComparison.Ordinal));
        var before = index.Sequence;

        await index.ReindexPlugin(fixture.Plugin);

        Assert.Equal(before + 1, index.Sequence);
    }

    [Fact]
    public async Task ASettledBatchNamingSeveralPlugins_AdvancesTheSequenceOnce()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-batch");
        var projector = MakeProjector(holder);
        using var _1 = projector;
        Reconcile(projector, holder, Snapshot(fx));
        var before = projector.Sequence;

        using (projector.BeginProjection())
        {
            await projector.ReindexPlugin(new PluginCopyKey("A.esm", PluginOrigin.DataDirectory));
            await projector.ReindexPlugin(new PluginCopyKey("B.esp", PluginOrigin.DataDirectory));
        }

        Assert.Equal(before + 1, projector.Sequence);
    }

    [Fact]
    public async Task TwoProjectionsOpenAtOnce_EachLandsItsOwnAdvance_AndNothingIsAnnouncedAheadOfTheStore()
    {
        using var fixture = IndexedModFixture.Tracked();
        var index = (IndexProjector)fixture.Index;
        var otherNpcSource = fixture.SourceFileFor(fixture.OtherNpc, "npc_", IndexedModFixture.OtherNpcEditorId);
        RenameByHand(fixture.NpcSourceFile, IndexedModFixture.NpcEditorId, "RenamedByHand");
        RenameByHand(otherNpcSource, IndexedModFixture.OtherNpcEditorId, "AlsoRenamedByHand");
        var before = index.Sequence;
        var announced = new ConcurrentBag<long>();

        // The two projections overlap without nesting — the first opens before the second and closes
        // before it — while every store call stays strictly ordered, since one connection is one
        // writer.
        using var firstOpen = new ManualResetEventSlim();
        using var secondOpen = new ManualResetEventSlim();
        using var firstClosed = new ManualResetEventSlim();

        var first = Task.Run(() =>
        {
            using (index.BeginProjection())
            {
                index.RefreshKeys(fixture.Plugin, [fixture.Npc.ToString()]);
                index.Announce(() => announced.Add(index.Sequence));
                firstOpen.Set();
                Wait(secondOpen);
            }
            firstClosed.Set();
        });

        var second = Task.Run(() =>
        {
            Wait(firstOpen);
            using (index.BeginProjection())
            {
                index.RefreshKeys(fixture.Plugin, [fixture.OtherNpc.ToString()]);
                index.Announce(() => announced.Add(index.Sequence));
                secondOpen.Set();
                Wait(firstClosed);
            }
        });

        await Task.WhenAll(first, second);

        Assert.Equal(before + 2, index.Sequence);
        Assert.Equal(2, announced.Count);
        Assert.All(announced, sequence => Assert.InRange(sequence, before + 1, index.Sequence));
    }

    private static void Wait(ManualResetEventSlim gate)
    {
        if (!gate.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("The other projection never got there.");
    }

    [Fact]
    public void ASettledSourceBatch_LandsWholeAsOneAdvance()
    {
        var notifications = new InMemoryNotificationPublisher();
        using var fixture = IndexedModFixture.Tracked(notifications);
        var index = (IndexProjector)fixture.Index;
        using var watcher = TestWatcher.Over(fixture.Holder, index, notifications);

        var otherNpcSource = fixture.SourceFileFor(
            fixture.OtherNpc, "npc_", IndexedModFixture.OtherNpcEditorId);
        RenameByHand(fixture.NpcSourceFile, IndexedModFixture.NpcEditorId, "RenamedByHand");
        RenameByHand(otherNpcSource, IndexedModFixture.OtherNpcEditorId, "AlsoRenamedByHand");
        var before = index.Sequence;

        // Two documents the watcher settled together: projected one at a time, they are two
        // advances, so this only holds while the batch opens one projection around both.
        watcher.ProjectSourceBatch([
            Settled(fixture, fixture.NpcSourceFile),
            Settled(fixture, otherNpcSource),
        ]);

        Assert.Equal(before + 1, index.Sequence);
    }

    private static SourceChangeEvent Settled(IndexedModFixture fixture, string documentPath) =>
        new(fixture.ActualPluginName, IndexedModFixture.ModFolderOrigin, fixture.ModFolder,
            SourceChangeScope.Documents, [documentPath]);

    private static void RenameByHand(string documentPath, string from, string to)
    {
        var text = File.ReadAllText(documentPath);
        File.WriteAllText(documentPath, text.Replace($"\"{from}\"", $"\"{to}\"", StringComparison.Ordinal));
    }

    [Fact]
    public void AnArrivingCopy_ReappliesTheFilter_SoItsRowsAnswerThroughIt()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-arriving-filter");
        var projector = MakeProjector(holder);
        using var _1 = projector;
        Reconcile(projector, holder, Snapshot(fx, [fx.Plugins[0]]));
        projector.SetFilter("SELECT form_key FROM records");

        Reconcile(projector, holder, Snapshot(fx));

        var arrived = fx.Plugins[1];
        var rows = projector.RequireReads().Search(new RecordQuery(
            Plugin: arrived.Name, Origin: arrived.Origin, Limit: 10, Offset: 0));
        Assert.NotEmpty(rows.Items);
    }

    [Fact]
    public void ARowsChangedNotification_WaitsForItsProjectionToLand_AndNamesTheSequenceItLandedOn()
    {
        var notifications = new InMemoryNotificationPublisher();
        using var fixture = IndexedModFixture.Tracked(notifications);
        var index = (IndexProjector)fixture.Index;
        var text = File.ReadAllText(fixture.NpcSourceFile);
        File.WriteAllText(fixture.NpcSourceFile, text.Replace(
            $"\"{IndexedModFixture.NpcEditorId}\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        using (index.BeginProjection())
        {
            index.RefreshKeys(fixture.Plugin, [fixture.Npc.ToString()]);
            Assert.Empty(notifications.Notifications.OfType<RowsChangedNotification>());
        }

        var landed = notifications.Notifications.OfType<RowsChangedNotification>().Single();
        Assert.Contains(fixture.Npc.ToString(), landed.Keys);
        Assert.Equal(index.Sequence, landed.Sequence);
    }

    [Fact]
    public void AFilteredReadAfterAProjection_ReflectsTheFilter_WithNoCallerReapplyingIt()
    {
        var holder = new LoadOrderHolder();
        // C.esp holds its own NPC rather than an override of A's, so its FormKey is one the filter
        // could not already have listed when it was first materialized.
        using var fx = new PluginFixtureBuilder("projector-filter")
            .WithPlugin("A.esm", mod => mod.Npcs.AddNew("AlphaNpc"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("CharlieNpc"))
            .BuildScattered();
        var projector = MakeProjector(holder);
        using var _1 = projector;
        var onlyA = fx.Plugins.Where(p => p.Name == "A.esm").ToList();
        Reconcile(projector, holder, Snapshot(fx, onlyA));
        projector.SetFilter("SELECT form_key FROM npc_");

        Reconcile(projector, holder, Snapshot(fx));

        var matched = projector.RequireReads()
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "C.esp", Origin: PluginOrigin.DataDirectory, Limit: 10, Offset: 0));
        Assert.Equal(["CharlieNpc"], matched.Items.Select(i => i.EditorId));
    }
}
