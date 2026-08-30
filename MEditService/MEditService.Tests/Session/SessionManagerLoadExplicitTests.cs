using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Session;

public sealed class SessionManagerLoadExplicitTests
{
    private static SessionManager MakeManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory);
    }

    [Fact]
    public void LoadExplicit_PopulatesSessionAndIndexesScatteredPlugins()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        using var manager = MakeManager();
        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.NotNull(manager.Session);
        Assert.NotNull(manager.Repository);
        Assert.Equal(1, manager.Repository!.GetRecordTypeCounts(new PluginKey("A.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        Assert.Equal(1, manager.Repository!.GetRecordTypeCounts(new PluginKey("B.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
    }

    [Fact]
    public void LoadExplicit_CrossPluginOverride_WinnerIsHighestOrderPlugin()
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
        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        var winner = manager.Repository!.GetDocument(shared.ToString());
        Assert.NotNull(winner);
        Assert.True(winner.IsWinner);
        Assert.Equal("Override.esp", winner.Plugin.Name);
    }

    [Fact]
    public void LoadExplicit_ReplacesPriorSession()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit-replace")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();

        using var manager = MakeManager();
        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var firstRepo = manager.Repository;

        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.NotSame(firstRepo, manager.Repository);
        Assert.ThrowsAny<Exception>(() => firstRepo!.GetRecordTypeCounts(new PluginKey("A.esp", "Data")));
    }

    // A single plugin whose binary data Mutagen can't parse (e.g. #<issue>: a malformed
    // PerkEntryPointAddActivateChoice missing its EPF3 record) must not abort the whole load
    // order — mirrors the existing per-plugin isolation around ModFactory.ImportGetter in
    // GameSession, extended to the indexing stage.
    [Fact]
    public void LoadExplicit_OnePluginFailsToIndex_OthersStillLoadAndFailureIsReported()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit-index-failure")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("Good.esp", mod => mod.Npcs.AddNew("FromGood"))
            .WithPlugin("Bad.esp", mod => mod.Npcs.AddNew("FromBad"))
            .BuildScattered();

        var reflector = SharedSchemaReflector.Instance;
        var innerFactory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var factory = new ThrowingOnIndexRepositoryFactory(innerFactory, "Bad.esp");
        using var manager = new SessionManager(factory);

        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.NotNull(manager.Session);
        Assert.Contains(manager.Session!.LoadFailures, f => f.Name == "Bad.esp");
        Assert.Equal(1, manager.Repository!.GetRecordTypeCounts(new PluginKey("Good.esp", "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        Assert.Equal(0, manager.Repository!.GetRecordTypeCounts(new PluginKey("Bad.esp", "Data"))
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
    // interface, which this class used to restate member for member.
    private sealed class ThrowingOnIndexRepository(IRecordIndex inner, string poisonPlugin)
        : DelegatingRecordIndex(inner)
    {
        public override void Index(IModGetter plugin, int loadOrderIndex, bool participates, PluginKey key, string? filePath = null)
        {
            if (plugin.ModKey.FileName.ToString().Equals(poisonPlugin, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"injected index failure for {poisonPlugin}");
            base.Index(plugin, loadOrderIndex, participates, key, filePath);
        }
    }
}
