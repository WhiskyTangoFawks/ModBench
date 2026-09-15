using DuckDB.NET.Data;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Plugins;

public sealed class ReconcileScatteredTests
{
    private static IndexProjector MakeManager(LoadOrderHolder holder)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        return new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
    }

    [Fact]
    public void Reconcile_PopulatesLoadOrderAndIndexesScatteredPlugins()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        using var manager = MakeManager(holder);
        manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.NotNull(manager.Reads);
        Assert.Equal(1, manager.Reads!.GetRecordTypeCounts(new PluginKey("A.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        Assert.Equal(1, manager.Reads!.GetRecordTypeCounts(new PluginKey("B.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
    }

    [Fact]
    public void Reconcile_CrossPluginOverride_WinnerIsHighestOrderPlugin()
    {
        var holder = new LoadOrderHolder();
        FormKey shared = default;
        using var fx = new PluginFixtureBuilder("sm-explicit-winner")
            .WithPlugin("Base.esm", mod => shared = mod.Npcs.AddNew("SharedNPC").FormKey)
            .WithPlugin("Override.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.Set(built.Single(m => m.ModKey.FileName == "Base.esm").Npcs.First().DeepCopy());
            })
            .BuildScattered();

        using var manager = MakeManager(holder);
        manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        var winner = manager.Reads!.GetDocument(shared.ToString());
        Assert.NotNull(winner);
        Assert.True(winner.IsWinner);
        Assert.Equal("Override.esp", winner.Plugin.Name);
    }

    [Fact]
    public void Reconcile_SameInstance_ReconcilesInPlace()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-replace")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();

        using var manager = MakeManager(holder);
        manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var firstRepo = manager.Reads;

        manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.Same(firstRepo, manager.Reads);
        Assert.NotEmpty(firstRepo!.GetRecordTypeCounts(new PluginKey("A.esp", "Data")));
    }

    // A single plugin whose binary data Mutagen can't parse (e.g.
    [Fact]
    public void Reconcile_OnePluginFailsToIndex_OthersStillLoadAndFailureIsReported()
    {
        var holder = new LoadOrderHolder();
        using var fx = new PluginFixtureBuilder("sm-explicit-index-failure")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("Good.esp", mod => mod.Npcs.AddNew("FromGood"))
            .WithPlugin("Bad.esp", mod => mod.Npcs.AddNew("FromBad"))
            .BuildScattered();

        var reflector = SharedSchemaReflector.Instance;
        var innerFactory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var factory = new ThrowingOnIndexRepositoryFactory(innerFactory, "Bad.esp");
        using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);

        manager.Reconcile(holder, fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.Contains(manager.Status.Failures, f => f.Name == "Bad.esp");
        Assert.Equal(1, manager.Reads!.GetRecordTypeCounts(new PluginKey("Good.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        Assert.Equal(0, manager.Reads!.GetRecordTypeCounts(new PluginKey("Bad.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        // The failed plugin's own indexing throw must hit the `continue` in IndexProgressively's
        // catch, not fall through into the "recorded once Index() has returned" block below it —
        // it never returned.
        Assert.DoesNotContain(manager.Status.IndexedPlugins, p => p.Name == "Bad.esp");
    }

    private sealed class ThrowingOnIndexRepositoryFactory(IRecordIndexFactory inner, string poisonPlugin)
        : IRecordIndexFactory
    {
        public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null) =>
            new ThrowingOnIndexRepository(inner.Create(gameRelease), poisonPlugin);
        public IRecordIndex Rebuild(GameRelease gameRelease, string instanceRoot, long atLeastSequence) =>
            inner.Rebuild(gameRelease, instanceRoot, atLeastSequence);
    }

    // Only Index is interesting here; DelegatingRecordIndex forwards the rest of the (wide)
    // interface.
    private sealed class ThrowingOnIndexRepository(IRecordIndex inner, string poisonPlugin)
        : DelegatingRecordIndex(inner)
    {
        public override void Index(
            IPluginDocuments documents, Registration registration, PluginKey key, string? filePath = null)
        {
            if (key.Name.Equals(poisonPlugin, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"injected index failure for {poisonPlugin}");
            base.Index(documents, registration, key, filePath);
        }
    }
}
