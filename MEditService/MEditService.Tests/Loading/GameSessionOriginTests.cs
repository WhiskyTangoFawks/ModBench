using MEditService.Core.Queries;
using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Tests.Loading;

// #269 / ADR-0036: plugin identity is (origin, filename), not filename alone. `origin` is the mod
// folder that provided the physical file, with reserved values for the game's Data directory and
// MO2's overwrite folder. This ticket only records and reports the value — nothing keys on it yet.
public sealed class GameSessionOriginTests
{
    [Fact]
    public void LoadSession_Plugin_OriginIsDataDirectory()
    {
        using var data = new PluginFixtureBuilder("gs-origin-plugin")
            .WithPlugin("UserMod.esp")
            .Build();

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4).Opened();

        var plugin = session.Plugins.Single(p => p.Name == "UserMod.esp");
        Assert.Equal(PluginOrigin.DataDirectory, plugin.Origin);
    }

    [Fact]
    public void LoadSession_ImplicitMaster_OriginIsDataDirectory()
    {
        using var data = new PluginFixtureBuilder("gs-origin-implicit")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin("UserMod.esp")
            .Build();

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4).Opened();

        var fo4 = session.Plugins.Single(p => p.Name == "Fallout4.esm");
        Assert.Equal(PluginOrigin.DataDirectory, fo4.Origin);
    }

    [Fact]
    public void AddPlugin_NewlyCreatedPlugin_OriginIsDataDirectory()
    {
        using var data = new PluginFixtureBuilder("gs-origin-add")
            .WithPlugin("Existing.esp")
            .Build();

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4).Opened();
        var newPath = Path.Combine(session.DataFolderPath, "New.esp");
        var mod = Mutagen.Bethesda.Plugins.Records.ModFactory.Activator(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("New.esp"), GameRelease.Fallout4);
        mod.WriteToBinary(newPath);

        var metadata = session.AddPlugin(newPath);

        Assert.Equal(PluginOrigin.DataDirectory, metadata.Origin);
    }

    [Fact]
    public void PluginResponse_ReportsOriginFromMetadata()
    {
        using var data = new PluginFixtureBuilder("gs-origin-response")
            .WithPlugin("UserMod.esp")
            .Build();

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4).Opened();
        var plugin = session.Plugins.Single(p => p.Name == "UserMod.esp");

        var response = PluginResponse.FromMetadata(plugin);

        Assert.Equal(PluginOrigin.DataDirectory, response.Origin);
    }

    [Fact]
    public void LoadExplicit_ImplicitMasterFromGameDir_OriginIsDataDirectory()
    {
        using var fx = new PluginFixtureBuilder("gs-origin-explicit-implicit")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("Mod.esp")
            .BuildScattered();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4).Opened();

        var master = session.Plugins.Single(p => p.Name == "Fallout4.esm");
        Assert.Equal(PluginOrigin.DataDirectory, master.Origin);
    }

    [Fact]
    public void LoadExplicit_WithOrigin_ExplicitPluginCarriesCallerSuppliedOrigin()
    {
        using var fx = new PluginFixtureBuilder("gs-origin-explicit-real")
            .WithPlugin("Mod.esp")
            .BuildScattered();
        var withOrigin = fx.Plugins.Select(p => (p.Name, p.Path, Origin: "SomeMod", p.Participates)).ToList();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, withOrigin, GameRelease.Fallout4).Opened();

        var mod = session.Plugins.Single(p => p.Name == "Mod.esp");
        Assert.Equal("SomeMod", mod.Origin);
    }
}
