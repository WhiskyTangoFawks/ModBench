using System.Collections.Concurrent;
using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

/// <summary>ADR-0015 invariant 3 and ADR-0013 invariant 4, at the Index's own seam: a load order
/// value in, registrations and one sequence advance out, over a real DuckDB.</summary>
public sealed class IndexerTests
{
    private static Indexer MakeIndexer(LoadOrderHolder holder) => Indexes.Open(holder);

    private static (Indexer Index, GatedPluginAdapter Opens) MakeCountingIndexer(LoadOrderHolder holder)
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
    private static void Reconcile(Indexer indexer, LoadOrderHolder holder, LoadOrderSnapshot snapshot) =>
        indexer.Reconcile(snapshot, holder.Apply(snapshot));

    // The binary watch's re-derivation: bytes that differ, then the settle's own poke.
    private static async Task ReDerive(Indexer indexer, LoadOrderEntry entry)
    {
        PluginBinaries.Touch(entry.Path);
        Assert.True(await indexer.RefreshBinary(entry.KeyOf(), entry.Path));
    }

    private static string SharedNpc(Indexer indexer) =>
        indexer.RequireReads()
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "A.esm", Limit: 10, Offset: 0))
            .Items.Single().FormKey;

    private static string? WinnerOf(Indexer indexer, string formKey)
    {
        var stack = indexer.RequireReads().GetOverrideStack(formKey)
            ?? throw new InvalidOperationException($"Expected {formKey} to resolve to an override stack.");
        return stack.Entries.Single(e => e.IsWinner).Plugin.Name;
    }

    // ADR-0013 invariant 4: the sweep is handed the kernel's load order. The holder alone takes the
    // next snapshot here, so the copies the Index has open still carry the old winner: an Indexer
    // reading them answers B.esp.
    [Fact]
    public async Task ASweepBetweenSnapshots_TakesItsWinnersFromTheHolder_NotFromTheCopiesItHasOpen()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("indexer-winners-from-holder");
        using var indexer = MakeIndexer(holder);
        Reconcile(indexer, holder, Snapshot(fx));
        var npc = SharedNpc(indexer);
        Assert.Equal("B.esp", WinnerOf(indexer, npc));

        var b = fx.Plugins.Single(p => p.Name == "B.esp");
        holder.Apply(Snapshot(fx, [.. fx.Plugins.Select(p => p.Name == "B.esp" ? p with { Winning = false } : p)]));
        await ReDerive(indexer, b);

        Assert.Equal("A.esm", WinnerOf(indexer, npc));
    }

    [Fact]
    public void Reconcile_RegistersExactlyTheLoadOrdersCopies()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("indexer-registrations");
        using var indexer = MakeIndexer(holder);
        var snapshot = Snapshot(fx);

        Reconcile(indexer, holder, snapshot);

        Assert.All(snapshot.Copies, copy => Assert.True(indexer.Registers(copy.Key)));
        Assert.Equal(
            snapshot.Copies.Select(c => c.Key).OrderBy(k => k.Name, StringComparer.Ordinal),
            indexer.RequireReads().OpenedCopies.Keys.OrderBy(k => k.Name, StringComparer.Ordinal));
        Assert.False(indexer.Registers(new PluginAddress("Nobody.esp", PluginOrigin.DataDirectory)));
    }

    // Header flags, the master list and the record count are read out of the file when the copy is
    // opened and are stored in no row, so the reads answer them from the copies the Index holds open.
    [Fact]
    public void TheReads_CarryTheContentFactsOfEveryCopyTheIndexOpened()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("indexer-opened-content");
        using var indexer = MakeIndexer(holder);
        var snapshot = Snapshot(fx);

        Reconcile(indexer, holder, snapshot);

        var opened = indexer.RequireReads().OpenedCopies;
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
        using var fx = TwoProviders("indexer-unopenable-content");
        using var indexer = MakeIndexer(holder);
        var gone = new LoadOrderEntry("Gone.esp", Path.Combine(fx.GameDirectory, "Gone.esp"), "SomeMod", 9, true, true);
        var snapshot = Snapshot(fx, [.. fx.Plugins, gone]);

        Reconcile(indexer, holder, snapshot);

        var opened = indexer.RequireReads().OpenedCopies;
        Assert.DoesNotContain(new PluginAddress("Gone.esp", "SomeMod"), opened.Keys);
        Assert.Contains(snapshot.Copies.Single(c => c.Name == "A.esm").Key, opened.Keys);
    }

    [Fact]
    public async Task AWholePluginProjection_AdvancesTheSequenceExactlyOnce()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("indexer-one-advance");
        using var indexer = MakeIndexer(holder);
        Reconcile(indexer, holder, Snapshot(fx));
        PluginBinaries.Touch(fx.Plugins.Single(p => p.Name == "B.esp").Path);
        var before = indexer.Sequence;

        Assert.True(await indexer.RefreshBinary(new PluginAddress("B.esp", PluginOrigin.DataDirectory), fx.Plugins.Single(p => p.Name == "B.esp").Path));

        Assert.Equal(before + 1, indexer.Sequence);
    }

    [Fact]
    public async Task ASettledBatchNamingSeveralPlugins_AdvancesTheSequenceOnce()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("indexer-batch");
        using var indexer = MakeIndexer(holder);
        Reconcile(indexer, holder, Snapshot(fx));
        foreach (var entry in fx.Plugins) PluginBinaries.Touch(entry.Path);
        var before = indexer.Sequence;

        using (indexer.BeginProjection())
        {
            foreach (var entry in fx.Plugins)
                Assert.True(await indexer.RefreshBinary(entry.KeyOf(), entry.Path));
        }

        Assert.Equal(before + 1, indexer.Sequence);
    }

    [Fact]
    public void AnArrivingCopy_ReappliesTheFilter_SoItsRowsAnswerThroughIt()
    {
        var holder = new LoadOrderHolder();
        using var fx = TwoProviders("indexer-arriving-filter");
        using var indexer = MakeIndexer(holder);
        Reconcile(indexer, holder, Snapshot(fx, [fx.Plugins[0]]));
        indexer.SetFilter("SELECT form_key FROM records", "filter.sql");

        Reconcile(indexer, holder, Snapshot(fx));

        var arrived = fx.Plugins[1];
        var rows = indexer.RequireReads().Search(new RecordQuery(
            Plugin: arrived.Name, Origin: arrived.Origin, Limit: 10, Offset: 0));
        Assert.NotEmpty(rows.Items);
    }

    [Fact]
    public void AFilteredReadAfterAProjection_ReflectsTheFilter_WithNoCallerReapplyingIt()
    {
        var holder = new LoadOrderHolder();
        // C.esp holds its own NPC rather than an override of A's, so its FormKey is one the filter
        // could not already have listed when it was first materialized.
        using var fx = new PluginFixtureBuilder("indexer-filter")
            .WithPlugin("A.esm", mod => mod.Npcs.AddNew("AlphaNpc"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("CharlieNpc"))
            .BuildScattered();
        using var indexer = MakeIndexer(holder);
        var onlyA = fx.Plugins.Where(p => p.Name == "A.esm").ToList();
        Reconcile(indexer, holder, Snapshot(fx, onlyA));
        indexer.SetFilter("SELECT form_key FROM npc_", "filter.sql");

        Reconcile(indexer, holder, Snapshot(fx));

        var matched = indexer.RequireReads()
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: "C.esp", Origin: PluginOrigin.DataDirectory, Limit: 10, Offset: 0));
        Assert.Equal(["CharlieNpc"], matched.Items.Select(i => i.EditorId));
    }
}
