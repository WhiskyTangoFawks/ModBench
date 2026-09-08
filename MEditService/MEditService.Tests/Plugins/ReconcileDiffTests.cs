using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Plugins;

// ADR-0044: PUT /load-order's one verb, at the Index seam. Every loadout gesture is the same
// reconcile, and the counting factory below tells a cheap SQL-only one from a cold indexing one.
public sealed class ReconcileDiffTests
{
    // Counts the two verbs whose cost the acceptance criteria are about: Index (a re-read plus a re-
    // index) and UpdateWinners (the whole-set sweep).
    private sealed class CountingFactory(IRecordIndexFactory inner) : IRecordIndexFactory
    {
        public int Indexed { get; set; }
        public int Sweeps { get; set; }
        public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null) =>
            new CountingIndex(inner.Create(gameRelease, instanceRoot), this);
        public IRecordIndex Rebuild(GameRelease gameRelease, string instanceRoot, long atLeastSequence) =>
            inner.Rebuild(gameRelease, instanceRoot, atLeastSequence);
    }

    private sealed class CountingIndex(IRecordIndex inner, CountingFactory owner) : DelegatingRecordIndex(inner)
    {
        public override void Index(IModGetter plugin, Registration registration, PluginKey key, string? filePath = null)
        {
            owner.Indexed++;
            base.Index(plugin, registration, key, filePath);
        }

        public override void UpdateWinners()
        {
            owner.Sweeps++;
            base.UpdateWinners();
        }
    }

    private static (IndexProjector Index, CountingFactory Counts) MakeIndex()
    {
        var reflector = SharedSchemaReflector.Instance;
        var counts = new CountingFactory(new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
        return (new IndexProjector(counts), counts);
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

    private static string SharedNpc(IndexProjector index) =>
        index.Reads!
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: new PluginKey("A.esm"), Limit: 10, Offset: 0))
            .Items.Single().FormKey;

    private static string? WinnerOf(IndexProjector index, string formKey) =>
        index.Reads!.GetOverrideStack(formKey)!.Entries.Single(e => e.IsWinner).Plugin.Name;

    private static IReadOnlyList<LoadOrderEntry> With(IReadOnlyList<LoadOrderEntry> plugins, string name, Func<LoadOrderEntry, LoadOrderEntry> change) =>
        plugins.Select(p => p.Name == name ? change(p) : p).ToList();

    [Fact]
    public void IdenticalSnapshotTwice_SecondIsANoOp_NoSweepNoProgress()
    {
        using var fx = TwoProviders("reconcile-noop");
        var (index, counts) = MakeIndex();
        using var _ = index;

        index.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var indexedAfterFirst = counts.Indexed;
        var statusAfterFirst = index.Status;
        Assert.Equal(1, counts.Sweeps);

        index.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.Equal(1, counts.Sweeps);
        Assert.Equal(indexedAfterFirst, counts.Indexed);
        Assert.Equal(statusAfterFirst.IndexedPlugins, index.Status.IndexedPlugins);
        Assert.Equal(statusAfterFirst.State, index.Status.State);
        Assert.True(index.Status.ConflictsComputed);
    }

    [Fact]
    public void Reorder_IsSqlOnly_AndWinnersFollowTheNewOrder()
    {
        using var fx = TwoProviders("reconcile-reorder");
        var (index, counts) = MakeIndex();
        using var _ = index;
        index.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var npc = SharedNpc(index);
        Assert.Equal("B.esp", WinnerOf(index, npc));
        var indexed = counts.Indexed;

        // Swap the two slots: A now loads after B.
        var swapped = fx.Plugins.Select(p => p with { Slot = p.Name == "A.esm" ? 1 : 0 }).ToList();
        index.Reconcile(fx.GameDirectory, swapped, GameRelease.Fallout4);

        Assert.Equal(indexed, counts.Indexed);
        Assert.Equal("A.esm", WinnerOf(index, npc));
        Assert.Equal(2, counts.Sweeps);
    }

    [Fact]
    public void Disable_IsSqlOnly_AndTheOtherProviderWins()
    {
        using var fx = TwoProviders("reconcile-disable");
        var (index, counts) = MakeIndex();
        using var _ = index;
        index.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var npc = SharedNpc(index);
        var indexed = counts.Indexed;

        index.Reconcile(fx.GameDirectory, With(fx.Plugins, "B.esp", p => p with { Enabled = false }), GameRelease.Fallout4);

        Assert.Equal(indexed, counts.Indexed);
        var b = index.LoadOrder!.Plugins.Single(p => p.Name == "B.esp");
        Assert.False(b.Participates);
        Assert.True(b.InLoadOrder);
        Assert.False(b.IsImmutable);
        Assert.Equal("A.esm", WinnerOf(index, npc));

        index.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        Assert.Equal(indexed, counts.Indexed);
        Assert.Equal("B.esp", WinnerOf(index, npc));
    }

    // A losing copy and the winning copy of one filename are both held and both registered
    // (ADR-0044: the snapshot is every physical copy); only the winning one can win.
    [Fact]
    public void LosingCopy_IsRegisteredBesideTheWinner_AndNeverWins()
    {
        using var fx = new PluginFixtureBuilder("reconcile-losing")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB"), origin: "ModB")
            .BuildScattered();
        var winner = fx.Plugins.Single(p => p.Origin == "ModA");
        var snapshot = fx.Plugins
            .Select(p => p.Origin == "ModB" ? p with { Slot = winner.Slot, Winning = false } : p)
            .ToList();
        var (index, _) = MakeIndex();
        using var __ = index;

        index.Reconcile(fx.GameDirectory, snapshot, GameRelease.Fallout4);

        var copies = index.LoadOrder!.Plugins.Where(p => p.Name == "Shared.esp").ToDictionary(p => p.Origin);
        Assert.True(copies["ModA"].Participates);
        Assert.False(copies["ModB"].Participates);
        Assert.True(copies["ModB"].IsImmutable);
        Assert.Equal(copies["ModA"].LoadOrderIndex, copies["ModB"].LoadOrderIndex);

        var stack = index.Reads!.GetOverrideStack("000800:Shared.esp")!.Entries;
        Assert.Equal(2, stack.Count);
        Assert.True(stack.Single(e => e.Plugin.Origin == "ModA").IsWinner);
        Assert.False(stack.Single(e => e.Plugin.Origin == "ModB").IsWinner);

        // Both copies are registered — the losing one is browsable, not absent.
        Assert.Contains(index.Store!.RegisteredPlugins(), k => k.Origin == "ModB");

        // Reprioritising the mods flips which copy wins — SQL-only, like every other move.
        var flipped = snapshot.Select(p => p with { Winning = p.Origin == "ModB" }).ToList();
        index.Reconcile(fx.GameDirectory, flipped, GameRelease.Fallout4);
        stack = index.Reads!.GetOverrideStack("000800:Shared.esp")!.Entries;
        Assert.True(stack.Single(e => e.Plugin.Origin == "ModB").IsWinner);
        Assert.False(index.LoadOrder!.Plugins.Single(p => p.Origin == "ModA").InLoadOrder);
    }

    // Uninstall: a copy absent from the snapshot is unregistered, its rows kept for its return.
    [Fact]
    public void CopyAbsentFromSnapshot_IsUnregistered_AndReturnsWithoutAReindex()
    {
        using var fx = TwoProviders("reconcile-leave");
        var (index, counts) = MakeIndex();
        using var _ = index;
        index.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var npc = SharedNpc(index);
        var indexed = counts.Indexed;
        var bKey = new PluginKey("B.esp", fx.Plugins.Single(p => p.Name == "B.esp").Origin);

        index.Reconcile(fx.GameDirectory, fx.Plugins.Where(p => p.Name != "B.esp").ToList(), GameRelease.Fallout4);

        Assert.DoesNotContain(index.LoadOrder!.Plugins, p => p.Name == "B.esp");
        Assert.DoesNotContain(index.Store!.RegisteredPlugins(), k => k.Name == "B.esp");
        Assert.DoesNotContain(index.Status.IndexedPlugins, p => p.Name == "B.esp");
        Assert.NotNull(index.Store!.IndexedContentHash(bKey));
        Assert.Equal("A.esm", WinnerOf(index, npc));

        index.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.Equal(indexed, counts.Indexed);
        Assert.Contains(index.LoadOrder!.Plugins, p => p.Name == "B.esp");
        Assert.Equal("B.esp", WinnerOf(index, npc));
    }

    // No clear-on-open: after a restart the file still carries its registrations, and the next
    // snapshot corrects them rather than re-indexing.
    [Fact]
    public void AfterRestart_IdenticalSnapshot_ReindexesNothing_AndADifferentOne_CorrectsTheRegistrations()
    {
        using var fx = TwoProviders("reconcile-restart");
        var (first, _) = MakeIndex();
        using (first)
        {
            first.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4, fx.InstanceRoot);
        }

        var (second, counts) = MakeIndex();
        using (second)
        {
            second.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4, fx.InstanceRoot);

            Assert.Equal(0, counts.Indexed);
            Assert.Equal("B.esp", WinnerOf(second, SharedNpc(second)));
            Assert.Equal(fx.Plugins.Count, second.Status.IndexedPlugins.Count);
        }

        var (third, thirdCounts) = MakeIndex();
        using (third)
        {
            third.Reconcile(fx.GameDirectory, fx.Plugins.Where(p => p.Name != "B.esp").ToList(), GameRelease.Fallout4, fx.InstanceRoot);

            Assert.Equal(0, thirdCounts.Indexed);
            Assert.DoesNotContain(third.Store!.RegisteredPlugins(), k => k.Name == "B.esp");
            Assert.Equal("A.esm", WinnerOf(third, SharedNpc(third)));
        }
    }

    [Fact]
    public void FailedCopy_IsAFailureOnTheRow_AndRecoversOnceItsBytesChange()
    {
        using var fx = new PluginFixtureBuilder("reconcile-failed").WithPlugin("Good.esp").BuildScattered();
        var badPath = Path.Combine(fx.Root, "Bad.esp");
        File.WriteAllBytes(badPath, [0xDE, 0xAD, 0xBE, 0xEF]);
        var snapshot = fx.Plugins.Append(new LoadOrderEntry("Bad.esp", badPath, "BadMod", 1, Enabled: true, Winning: true)).ToList();
        var (index, counts) = MakeIndex();
        using var _ = index;

        index.Reconcile(fx.GameDirectory, snapshot, GameRelease.Fallout4);

        Assert.Contains(index.Status.Failures, f => f.Name == "Bad.esp");
        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.DoesNotContain(index.LoadOrder!.Plugins, p => p.Name == "Bad.esp");

        // The same snapshot again is a no-op — the failed parse is not paid twice.
        var sweeps = counts.Sweeps;
        index.Reconcile(fx.GameDirectory, snapshot, GameRelease.Fallout4);
        Assert.Equal(sweeps, counts.Sweeps);

        new Fallout4Mod(ModKey.FromFileName("Bad.esp"), Fallout4Release.Fallout4).WriteToBinary(badPath);
        index.Reconcile(fx.GameDirectory, snapshot, GameRelease.Fallout4);

        Assert.Empty(index.Status.Failures);
        Assert.Contains(index.LoadOrder!.Plugins, p => p.Name == "Bad.esp");
    }

    [Fact]
    public void ADifferentInstance_ReplacesWhatIsHeld()
    {
        using var fx = TwoProviders("reconcile-other-instance");
        var (index, _) = MakeIndex();
        using var __ = index;
        index.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4, fx.InstanceRoot);
        var first = index.LoadOrder;
        var otherInstance = Directory.CreateDirectory(Path.Combine(fx.Root, "other-instance")).FullName;

        index.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4, otherInstance);

        Assert.NotSame(first, index.LoadOrder);
        Assert.Equal(otherInstance, index.LoadOrder!.InstanceRoot);
    }
}
