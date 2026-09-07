using System.Globalization;
using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>ADR-0046 invariants 10 and 11, at the Index's own seam: a load order value in,
/// registration rows and one sequence advance out, over a real DuckDB.</summary>
public sealed class IndexProjectorTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;

    // Counts the verb the "without re-indexing" criterion is about.
    private sealed class CountingFactory(IRecordIndexFactory inner) : IRecordIndexFactory
    {
        public int Indexed { get; set; }
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
    }

    private static IndexProjector MakeProjector() =>
        new(new DuckDbRecordIndexFactory(Reflector, new TableDdlBuilder(Reflector)));

    private static (IndexProjector Projector, CountingFactory Counts) MakeCountingProjector()
    {
        var counts = new CountingFactory(new DuckDbRecordIndexFactory(Reflector, new TableDdlBuilder(Reflector)));
        return (new IndexProjector(counts), counts);
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

    private static LoadOrder Snapshot(ScatteredFixtureData fx, IReadOnlyList<LoadOrderEntry>? plugins = null) =>
        LoadOrder.From(fx.GameDirectory, fx.InstanceRoot, GameRelease.Fallout4, plugins ?? fx.Plugins);

    private static IReadOnlyList<RegisteredCopy> RegistrationRows(IndexProjector projector)
    {
        var connection = ((DuckDbRecordIndex)projector.Index!).Connection;
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT plugin, origin, load_order_idx, enabled, winning FROM registrations";
        using var reader = cmd.ExecuteReader();
        var rows = new List<RegisteredCopy>();
        while (reader.Read())
        {
            rows.Add(new RegisteredCopy(
                reader.GetString(0), reader.GetString(1), Path: string.Empty,
                reader.IsDBNull(2) ? null : reader.GetInt32(2), reader.GetBoolean(3), reader.GetBoolean(4)));
        }
        return rows;
    }

    private static string SharedNpc(IndexProjector projector) =>
        projector.Reads!
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: new PluginKey("A.esm"), Limit: 10, Offset: 0))
            .Items.Single().FormKey;

    private static string? WinnerOf(IndexProjector projector, string formKey) =>
        projector.Reads!.GetOverrideStack(formKey)!.Entries.Single(e => e.IsWinner).Plugin.Name;

    [Fact]
    public void Reconcile_MakesTheRegistrationRowsEqualTheLoadOrdersCopies()
    {
        using var fx = TwoProviders("projector-registrations");
        var projector = MakeProjector();
        using var _1 = projector;
        var snapshot = Snapshot(fx);

        projector.Reconcile(snapshot);

        // Path is not a registration fact, so the rows are compared on the five that are.
        Assert.Equal(
            snapshot.Copies.Select(c => (c.Name, c.Origin, c.Slot, c.Enabled, c.Winning)).OrderBy(c => c.Name).ToList(),
            RegistrationRows(projector).Select(c => (c.Name, c.Origin, c.Slot, c.Enabled, c.Winning)).OrderBy(c => c.Name).ToList());
    }

    [Fact]
    public void ACopyDroppedFromTheSnapshot_LosesItsRegistrationRow_OnTheNextReconcile()
    {
        using var fx = TwoProviders("projector-registrations-drop");
        var projector = MakeProjector();
        using var _1 = projector;
        projector.Reconcile(Snapshot(fx));

        var withoutB = fx.Plugins.Where(p => p.Name != "B.esp").ToList();
        projector.Reconcile(Snapshot(fx, withoutB));

        Assert.Equal(["A.esm"], RegistrationRows(projector).Select(r => r.Name));
    }

    [Fact]
    public void ACopyThatStopsParticipating_LosesItsWinners_OnTheNextReconcile_WithNoReindex()
    {
        using var fx = TwoProviders("projector-stops-participating");
        var (projector, counts) = MakeCountingProjector();
        using var _1 = projector;
        projector.Reconcile(Snapshot(fx));
        var npc = SharedNpc(projector);
        Assert.Equal("B.esp", WinnerOf(projector, npc));
        var indexed = counts.Indexed;

        var bDisabled = fx.Plugins.Select(p => p.Name == "B.esp" ? p with { Enabled = false } : p).ToList();
        projector.Reconcile(Snapshot(fx, bDisabled));

        Assert.Equal("A.esm", WinnerOf(projector, npc));
        Assert.Equal(indexed, counts.Indexed);
    }

    [Fact]
    public void AnIdenticalSnapshot_IsANoOp_BySequence()
    {
        using var fx = TwoProviders("projector-identical");
        var projector = MakeProjector();
        using var _1 = projector;
        projector.Reconcile(Snapshot(fx));
        var settled = projector.Sequence;

        projector.Reconcile(Snapshot(fx));

        Assert.Equal(settled, projector.Sequence);
    }

    [Fact]
    public async Task AWholePluginProjection_AdvancesTheSequenceExactlyOnce()
    {
        using var fx = TwoProviders("projector-one-advance");
        var projector = MakeProjector();
        using var _1 = projector;
        projector.Reconcile(Snapshot(fx));
        var before = projector.Sequence;

        await projector.ReindexPlugin(new PluginKey("B.esp", PluginOrigin.DataDirectory));

        Assert.Equal(before + 1, projector.Sequence);
    }

    [Fact]
    public async Task ATrackedCopyReDerivedFromADirtyTree_AdvancesTheSequenceExactlyOnce()
    {
        using var fixture = TrackedModFixture.Tracked();
        var mirror = (ILoadOrderMirror)fixture.Mirror;
        // Dirty, so the head reconcile has baselines to write: a clean tree short-circuits it and
        // would leave the multi-advance case untested.
        var text = File.ReadAllText(fixture.NpcSourceFile);
        File.WriteAllText(fixture.NpcSourceFile, text.Replace(
            $"\"{TrackedModFixture.NpcEditorId}\"", "\"RenamedByHand\"", StringComparison.Ordinal));
        var before = mirror.Sequence;

        await mirror.ReindexPlugin(fixture.Plugin);

        Assert.Equal(before + 1, mirror.Sequence);
    }

    [Fact]
    public async Task ASettledBatchNamingSeveralPlugins_AdvancesTheSequenceOnce()
    {
        using var fx = TwoProviders("projector-batch");
        var projector = MakeProjector();
        using var _1 = projector;
        projector.Reconcile(Snapshot(fx));
        var before = projector.Sequence;

        using (projector.BeginProjection())
        {
            await projector.ReindexPlugin(new PluginKey("A.esm", PluginOrigin.DataDirectory));
            await projector.ReindexPlugin(new PluginKey("B.esp", PluginOrigin.DataDirectory));
        }

        Assert.Equal(before + 1, projector.Sequence);
    }

    [Fact]
    public void ARowsChangedNotification_WaitsForItsProjectionToLand_AndNamesTheSequenceItLandedOn()
    {
        var notifications = new InMemoryNotificationPublisher();
        using var fixture = TrackedModFixture.Tracked(notifications);
        var mirror = (ILoadOrderMirror)fixture.Mirror;
        var text = File.ReadAllText(fixture.NpcSourceFile);
        File.WriteAllText(fixture.NpcSourceFile, text.Replace(
            $"\"{TrackedModFixture.NpcEditorId}\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        using (mirror.BeginProjection())
        {
            mirror.RefreshKeys(fixture.Plugin, [fixture.Npc.ToString()]);
            Assert.Empty(notifications.Notifications.OfType<RowsChangedNotification>());
        }

        var landed = notifications.Notifications.OfType<RowsChangedNotification>().Single();
        Assert.Contains(fixture.Npc.ToString(), landed.Keys);
        Assert.Equal(mirror.Sequence, landed.Sequence);
    }

    [Fact]
    public void AFilteredReadAfterAProjection_ReflectsTheFilter_WithNoCallerReapplyingIt()
    {
        // C.esp holds its own NPC rather than an override of A's, so its FormKey is one the filter
        // could not already have listed when it was first materialized.
        using var fx = new PluginFixtureBuilder("projector-filter")
            .WithPlugin("A.esm", mod => mod.Npcs.AddNew("AlphaNpc"))
            .WithPlugin("C.esp", mod => mod.Npcs.AddNew("CharlieNpc"))
            .BuildScattered();
        var projector = MakeProjector();
        using var _1 = projector;
        var onlyA = fx.Plugins.Where(p => p.Name == "A.esm").ToList();
        projector.Reconcile(Snapshot(fx, onlyA));
        projector.SetFilter("SELECT form_key FROM npc_");

        projector.Reconcile(Snapshot(fx));

        var matched = projector.Reads!
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: new PluginKey("C.esp", PluginOrigin.DataDirectory), Limit: 10, Offset: 0));
        Assert.Equal(["CharlieNpc"], matched.Items.Select(i => i.EditorId));
    }
}
