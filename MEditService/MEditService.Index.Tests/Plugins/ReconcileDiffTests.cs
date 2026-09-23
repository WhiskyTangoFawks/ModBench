using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Plugins;

// ADR-0013: PUT /load-order's one verb, at the Index seam. The adapter's opens tell a cheap SQL-only
// move from a cold indexing one, and the sequence tells whether a sweep ran.
public sealed class ReconcileDiffTests
{
    private static (Indexer Index, GatedPluginAdapter Opens) MakeIndex(LoadOrderHolder holder)
    {
        var opens = new GatedPluginAdapter();
        return (Indexes.Open(holder, opens), opens);
    }

    // A.esm defines SharedNPC; B.esp overrides it — the two-provider stack every winner assertion
    // below reads.
    private static ScatteredFixtureData TwoProviders(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin("A.esm", mod => mod.Npcs.AddNew("SharedNPC"))
            .WithPlugin("B.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("A.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .BuildScattered();

    private static IRecordReads ReadsOf(Indexer index) =>
        index.RequireReads();

    private static RecordOverrides OverrideStackOf(Indexer index, string formKey) =>
        ReadsOf(index).GetOverrideStack(formKey)
            ?? throw new InvalidOperationException($"Expected an override stack for '{formKey}'.");

    private static string SharedNpc(Indexer index) =>
        ReadsOf(index)
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "A.esm", Limit: 10, Offset: 0))
            .Items.Single().FormKey;

    private static string? WinnerOf(Indexer index, string formKey) =>
        OverrideStackOf(index, formKey).Entries.Single(e => e.IsWinner).Plugin.Name;

    private static IReadOnlyList<LoadOrderEntry> With(IReadOnlyList<LoadOrderEntry> plugins, string name, Func<LoadOrderEntry, LoadOrderEntry> change) =>
        plugins.Select(p => p.Name == name ? change(p) : p).ToList();

    [Fact]
    public void IdenticalSnapshotTwice_SecondIsANoOp_NoSweepNoProgress()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-noop");
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;

        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var openedAfterFirst = opens.OpenedTotal;
        var statusAfterFirst = index.Status;
        var sequenceAfterFirst = index.Sequence;
        Assert.True(statusAfterFirst.ConflictsComputed);

        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        // No sweep: a sweep is a projection, and a projection advances the sequence.
        Assert.Equal(sequenceAfterFirst, index.Sequence);
        Assert.Equal(openedAfterFirst, opens.OpenedTotal);
        Assert.Equal(statusAfterFirst.IndexedPlugins, index.Status.IndexedPlugins);
        Assert.Equal(statusAfterFirst.State, index.Status.State);
        Assert.True(index.Status.ConflictsComputed);
    }

    [Fact]
    public void Reorder_IsSqlOnly_AndWinnersFollowTheNewOrder()
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

        // Swap the two slots: A now loads after B.
        var swapped = fx.Plugins.Select(p => p with { Slot = p.Name == "A.esm" ? 1 : 0 }).ToList();
        index.Reconcile(holder, fx.GameDirectory, swapped, GameRelease.Fallout4);

        Assert.Equal(opened, opens.OpenedTotal);
        Assert.Equal("A.esm", WinnerOf(index, npc));
        Assert.True(index.Sequence > sequence, "a reorder is a sweep, and a sweep is a projection");
    }

    [Fact]
    public void Disable_IsSqlOnly_AndTheOtherProviderWins()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-disable");
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;
        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var npc = SharedNpc(index);
        var opened = opens.OpenedTotal;
        var bKey = new PluginCopyKey("B.esp", fx.Plugins.Single(p => p.Name == "B.esp").Origin);

        index.Reconcile(holder, fx.GameDirectory, With(fx.Plugins, "B.esp", p => p with { Enabled = false }), GameRelease.Fallout4);

        Assert.Equal(opened, opens.OpenedTotal);
        // Still registered and still in the load order — browsable at its slot — but a disabled copy
        // competes for nothing.
        Assert.True(index.Registers(bKey));
        var b = OverrideStackOf(index, npc).Entries.Single(e => e.Plugin.Equals(bKey));
        Assert.Equal(1, b.LoadOrderIndex);
        Assert.False(b.IsWinner);
        Assert.Equal("A.esm", WinnerOf(index, npc));

        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        Assert.Equal(opened, opens.OpenedTotal);
        Assert.Equal("B.esp", WinnerOf(index, npc));
    }

    // A losing copy and the winning copy of one filename are both held and both registered
    // (ADR-0013: the snapshot is every physical copy); only the winning one can win.
    [Fact]
    public void LosingCopy_IsRegisteredBesideTheWinner_AndNeverWins()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("reconcile-losing")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB"), origin: "ModB")
            .BuildScattered();
        var winner = fx.Plugins.Single(p => p.Origin == "ModA");
        var snapshot = fx.Plugins
            .Select(p => p.Origin == "ModB" ? p with { Slot = winner.Slot, Winning = false } : p)
            .ToList();
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;

        index.Reconcile(holder, fx.GameDirectory, snapshot, GameRelease.Fallout4);

        var modA = new PluginCopyKey("Shared.esp", "ModA");
        var modB = new PluginCopyKey("Shared.esp", "ModB");
        var stack = OverrideStackOf(index, "000800:Shared.esp").Entries;
        Assert.Equal(2, stack.Count);
        Assert.True(stack.Single(e => e.Plugin.Equals(modA)).IsWinner);
        Assert.False(stack.Single(e => e.Plugin.Equals(modB)).IsWinner);
        Assert.Equal(stack.Single(e => e.Plugin.Equals(modA)).LoadOrderIndex, stack.Single(e => e.Plugin.Equals(modB)).LoadOrderIndex);

        // Both copies are registered — the losing one is browsable, not absent.
        Assert.True(index.Registers(modB));
        Assert.NotEmpty(ReadsOf(index).GetDocuments(modB));

        // Reprioritising the mods flips which copy wins — SQL-only, like every other move.
        var opened = opens.OpenedTotal;
        var flipped = snapshot.Select(p => p with { Winning = p.Origin == "ModB" }).ToList();
        index.Reconcile(holder, fx.GameDirectory, flipped, GameRelease.Fallout4);
        stack = OverrideStackOf(index, "000800:Shared.esp").Entries;
        Assert.True(stack.Single(e => e.Plugin.Equals(modB)).IsWinner);
        Assert.False(stack.Single(e => e.Plugin.Equals(modA)).IsWinner);
        Assert.Equal(opened, opens.OpenedTotal);
    }

    // Uninstall: a copy absent from the snapshot is unregistered, its rows kept for its return.
    [Fact]
    public void CopyAbsentFromSnapshot_IsUnregistered_AndReturnsWithoutAReindex()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("reconcile-leave");
        var (index, opens) = MakeIndex(holder);
        using var _ = index;
        using var __ = opens;
        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var npc = SharedNpc(index);
        var opened = opens.OpenedTotal;
        var bKey = new PluginCopyKey("B.esp", fx.Plugins.Single(p => p.Name == "B.esp").Origin);

        index.Reconcile(holder, fx.GameDirectory, fx.Plugins.Where(p => p.Name != "B.esp").ToList(), GameRelease.Fallout4);

        var readsAfterLeaving = ReadsOf(index);
        Assert.DoesNotContain(readsAfterLeaving.OpenedCopies.Keys, k => k.Name == "B.esp");
        Assert.False(index.Registers(bKey));
        Assert.Empty(readsAfterLeaving.GetDocuments(bKey));
        Assert.DoesNotContain(index.Status.IndexedPlugins, p => p.Name == "B.esp");
        Assert.Equal("A.esm", WinnerOf(index, npc));

        index.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.Equal(opened, opens.OpenedTotal);
        Assert.Contains(ReadsOf(index).OpenedCopies.Keys, k => k.Name == "B.esp");
        Assert.Equal("B.esp", WinnerOf(index, npc));
    }

    // No clear-on-open: after a restart the file still carries its registrations, and the next
    // snapshot corrects them rather than re-indexing.
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
            Assert.False(third.Registers(new PluginCopyKey("B.esp", fx.Plugins.Single(p => p.Name == "B.esp").Origin)));
            Assert.Equal("A.esm", WinnerOf(third, SharedNpc(third)));
        }
    }

    [Fact]
    public void FailedCopy_IsAFailureOnTheRow_AndRecoversOnceItsBytesChange()
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
        Assert.DoesNotContain(ReadsOf(index).OpenedCopies.Keys, k => k.Name == "Bad.esp");

        // The same snapshot again is a no-op — the failed parse is not paid twice, and no sweep runs.
        var sequence = index.Sequence;
        index.Reconcile(holder, fx.GameDirectory, snapshot, GameRelease.Fallout4);
        Assert.Equal(sequence, index.Sequence);

        new Fallout4Mod(ModKey.FromFileName("Bad.esp"), Fallout4Release.Fallout4).WriteToBinary(badPath);
        index.Reconcile(holder, fx.GameDirectory, snapshot, GameRelease.Fallout4);

        Assert.Empty(index.Status.Failures);
        Assert.Contains(ReadsOf(index).OpenedCopies.Keys, k => k.Name == "Bad.esp");
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
