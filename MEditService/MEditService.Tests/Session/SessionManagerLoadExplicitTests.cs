using MEditService.Core.Edits;
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
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
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
        Assert.Equal(1, manager.Repository!.CountRecordsForPlugin("npc_", "A.esp"));
        Assert.Equal(1, manager.Repository!.CountRecordsForPlugin("npc_", "B.esp"));
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

        var winner = manager.Repository!.GetRecord("npc_", shared.ToString(), null, winnerOnly: true);
        Assert.NotNull(winner);
        Assert.True(winner.IsWinner);
        Assert.Equal("Override.esp", winner.Plugin);
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
        Assert.ThrowsAny<Exception>(() => firstRepo!.CountRecordsForPlugin("npc_", "A.esp"));
    }
}
