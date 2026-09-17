using System.Collections.Concurrent;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>ADR-0015 invariant 3 and ADR-0013 invariant 4, at the Index's own seam: a load order
/// value in, registrations and one sequence advance out, over a real DuckDB.</summary>
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
        new(fx.GameDirectory, fx.InstanceRoot, GameRelease.Fallout4, SnapshotCopies.Of(plugins ?? fx.Plugins));

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
        using var projector = MakeProjector(holder);
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
        using var projector = MakeProjector(holder);
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
        using var projector = MakeProjector(holder);
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
        using var projector = MakeProjector(holder);
        var gone = new LoadOrderEntry("Gone.esp", Path.Combine(fx.GameDirectory, "Gone.esp"), "SomeMod", 9, true, true);
        var snapshot = Snapshot(fx, [.. fx.Plugins, gone]);

        Reconcile(projector, holder, snapshot);

        var opened = projector.RequireReads().OpenedCopies;
        Assert.DoesNotContain(new PluginCopyKey("Gone.esp", "SomeMod"), opened.Keys);
        Assert.Contains(snapshot.Copies.Single(c => c.Name == "A.esm").Key, opened.Keys);
    }

    [Fact]
    public async Task AWholePluginProjection_AdvancesTheSequenceExactlyOnce()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-one-advance");
        using var projector = MakeProjector(holder);
        Reconcile(projector, holder, Snapshot(fx));
        var before = projector.Sequence;

        await projector.ReindexPlugin(new PluginCopyKey("B.esp", PluginOrigin.DataDirectory));

        Assert.Equal(before + 1, projector.Sequence);
    }

    [Fact]
    public async Task ASettledBatchNamingSeveralPlugins_AdvancesTheSequenceOnce()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-batch");
        using var projector = MakeProjector(holder);
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
    public void AnArrivingCopy_ReappliesTheFilter_SoItsRowsAnswerThroughIt()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("projector-arriving-filter");
        using var projector = MakeProjector(holder);
        Reconcile(projector, holder, Snapshot(fx, [fx.Plugins[0]]));
        projector.SetFilter("SELECT form_key FROM records");

        Reconcile(projector, holder, Snapshot(fx));

        var arrived = fx.Plugins[1];
        var rows = projector.RequireReads().Search(new RecordQuery(
            Plugin: arrived.Name, Origin: arrived.Origin, Limit: 10, Offset: 0));
        Assert.NotEmpty(rows.Items);
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
        using var projector = MakeProjector(holder);
        var onlyA = fx.Plugins.Where(p => p.Name == "A.esm").ToList();
        Reconcile(projector, holder, Snapshot(fx, onlyA));
        projector.SetFilter("SELECT form_key FROM npc_");

        Reconcile(projector, holder, Snapshot(fx));

        var matched = projector.RequireReads()
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "C.esp", Origin: PluginOrigin.DataDirectory, Limit: 10, Offset: 0));
        Assert.Equal(["CharlieNpc"], matched.Items.Select(i => i.EditorId));
    }
}

/// <summary>The same seam over a tracked mod: what the sequence and the rows-changed port answer
/// while the projections that move a working tree are in flight.</summary>
public sealed class TrackedProjectionTests : IDisposable
{
    private const string NpcEditorId = "FixtureNpc";
    private const string OtherNpcEditorId = "UntouchedNpc";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly IndexProjector _index;
    private readonly string _npc;
    private readonly string _otherNpc;

    public TrackedProjectionTests()
    {
        FormKey npc = default, otherNpc = default;
        _fixture = new PluginFixtureBuilder("tracked-projection")
            .WithPlugin("Fixture.esp", mod =>
            {
                npc = mod.Npcs.AddNew(NpcEditorId).FormKey;
                otherNpc = mod.Npcs.AddNew(OtherNpcEditorId).FormKey;
            }, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _mod = _fixture.Plugins.Single();
        (_npc, _otherNpc) = (npc.ToString(), otherNpc.ToString());
        _index = Indexes.Reconciled(_fixture, notifications: _notifications);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void RenameByHand(string formKey, string from, string to) =>
        _mod.HandEdit(_index.RequireReads().DocumentOf(formKey, _mod.KeyOf()), $"\"{from}\"", $"\"{to}\"");

    [Fact]
    public async Task ATrackedCopyReDerivedFromADirtyTree_AdvancesTheSequenceExactlyOnce()
    {
        // Dirty, so the head reconcile has baselines to write: a clean tree short-circuits it and
        // would leave the multi-advance case untested.
        RenameByHand(_npc, NpcEditorId, "RenamedByHand");
        var before = _index.Sequence;

        await _index.ReindexPlugin(_mod.KeyOf());

        Assert.Equal(before + 1, _index.Sequence);
    }

    [Fact]
    public void ARowsChangedNotification_WaitsForItsProjectionToLand_AndNamesTheSequenceItLandedOn()
    {
        RenameByHand(_npc, NpcEditorId, "RenamedByHand");

        using (_index.BeginProjection())
        {
            _index.RefreshKeys(_mod.KeyOf(), [_npc]);
            Assert.Empty(_notifications.Notifications.OfType<RowsChangedNotification>());
        }

        var landed = _notifications.Notifications.OfType<RowsChangedNotification>().Single();
        Assert.Contains(_npc, landed.Keys);
        Assert.Equal(_index.Sequence, landed.Sequence);
    }

    [Fact]
    public async Task TwoProjectionsOpenAtOnce_EachLandsItsOwnAdvance_AndNothingIsAnnouncedAheadOfTheStore()
    {
        RenameByHand(_npc, NpcEditorId, "RenamedByHand");
        RenameByHand(_otherNpc, OtherNpcEditorId, "AlsoRenamedByHand");
        var before = _index.Sequence;
        var announced = new ConcurrentBag<long>();

        // The two projections overlap without nesting — the first opens before the second and closes
        // before it — while every store call stays strictly ordered, since one connection is one
        // writer.
        using var firstOpen = new ManualResetEventSlim();
        using var secondOpen = new ManualResetEventSlim();
        using var firstClosed = new ManualResetEventSlim();

        var first = Task.Run(() =>
        {
            using (_index.BeginProjection())
            {
                _index.RefreshKeys(_mod.KeyOf(), [_npc]);
                _index.Announce(() => announced.Add(_index.Sequence));
                firstOpen.Set();
                Wait(secondOpen);
            }
            firstClosed.Set();
        });

        var second = Task.Run(() =>
        {
            Wait(firstOpen);
            using (_index.BeginProjection())
            {
                _index.RefreshKeys(_mod.KeyOf(), [_otherNpc]);
                _index.Announce(() => announced.Add(_index.Sequence));
                secondOpen.Set();
                Wait(firstClosed);
            }
        });

        await Task.WhenAll(first, second);

        Assert.Equal(before + 2, _index.Sequence);
        Assert.Equal(2, announced.Count);
        Assert.All(announced, sequence => Assert.InRange(sequence, before + 1, _index.Sequence));
    }

    private static void Wait(ManualResetEventSlim gate)
    {
        if (!gate.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("The other projection never got there.");
    }
}
