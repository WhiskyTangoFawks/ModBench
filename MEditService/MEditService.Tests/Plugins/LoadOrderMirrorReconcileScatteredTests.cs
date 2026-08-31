using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Plugins;

public sealed class LoadOrderMirrorReconcileScatteredTests
{
    private static LoadOrderMirror MakeManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        return new LoadOrderMirror(factory);
    }

    [Fact]
    public void Reconcile_PopulatesLoadOrderAndIndexesScatteredPlugins()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        using var manager = MakeManager();
        manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.NotNull(manager.LoadOrder);
        Assert.NotNull(manager.Reads);
        Assert.Equal(1, manager.Reads!.GetRecordTypeCounts(new PluginKey("A.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        Assert.Equal(1, manager.Reads!.GetRecordTypeCounts(new PluginKey("B.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
    }

    [Fact]
    public void Reconcile_CrossPluginOverride_WinnerIsHighestOrderPlugin()
    {
        FormKey shared = default;
        using var fx = new PluginFixtureBuilder("sm-explicit-winner")
            .WithPlugin("Base.esm", mod => shared = mod.Npcs.AddNew("SharedNPC").FormKey)
            .WithPlugin("Override.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.Set(built.Single(m => m.ModKey.FileName == "Base.esm").Npcs.First().DeepCopy());
            })
            .BuildScattered();

        using var manager = MakeManager();
        manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        var winner = manager.Reads!.GetDocument(shared.ToString());
        Assert.NotNull(winner);
        Assert.True(winner.IsWinner);
        Assert.Equal("Override.esp", winner.Plugin.Name);
    }

    [Fact]
    public void Reconcile_SameInstance_ReconcilesInPlace()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit-replace")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();

        using var manager = MakeManager();
        manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var firstRepo = manager.Reads;

        manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.Same(firstRepo, manager.Reads);
        Assert.NotEmpty(firstRepo!.GetRecordTypeCounts(new PluginKey("A.esp", "Data")));
    }

    // A single plugin whose binary data Mutagen can't parse (e.g. a malformed
    // PerkEntryPointAddActivateChoice missing its EPF3 record) must not abort the whole load
    // order — mirrors the existing per-plugin isolation around ModFactory.ImportGetter in
    // LoadOrder, extended to the indexing stage.
    [Fact]
    public void Reconcile_OnePluginFailsToIndex_OthersStillLoadAndFailureIsReported()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit-index-failure")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("Good.esp", mod => mod.Npcs.AddNew("FromGood"))
            .WithPlugin("Bad.esp", mod => mod.Npcs.AddNew("FromBad"))
            .BuildScattered();

        var reflector = SharedSchemaReflector.Instance;
        var innerFactory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var factory = new ThrowingOnIndexRepositoryFactory(innerFactory, "Bad.esp");
        using var manager = new LoadOrderMirror(factory);

        manager.Reconcile(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.NotNull(manager.LoadOrder);
        Assert.Contains(manager.LoadOrder!.LoadFailures, f => f.Name == "Bad.esp");
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
    }

    // Only Index is interesting here; DelegatingRecordIndex forwards the rest of the (wide)
    // interface.
    private sealed class ThrowingOnIndexRepository(IRecordIndex inner, string poisonPlugin)
        : DelegatingRecordIndex(inner)
    {
        public override void Index(IModGetter plugin, Registration registration, PluginKey key, string? filePath = null)
        {
            if (plugin.ModKey.FileName.ToString().Equals(poisonPlugin, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"injected index failure for {poisonPlugin}");
            base.Index(plugin, registration, key, filePath);
        }
    }
}
