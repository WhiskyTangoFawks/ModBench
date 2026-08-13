using MEditService.Core.Queries;
using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Tests.Loading;

// #267: the editing session indexes every plugins.txt entry, enabled or disabled — a disabled
// plugin becomes present and inert rather than absent. Participation is the `*` prefix.
public sealed class GameSessionParticipationTests
{
    [Fact]
    public void DisabledPlugin_IsStillIndexed_WithParticipatesFalse()
    {
        using var data = new PluginFixtureBuilder("gs-participation")
            .WithPlugin("Enabled.esp")
            .WithPlugin("Disabled.esp", enabled: false)
            .Build();

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4).Opened();

        var enabled = session.Plugins.Single(p => p.Name == "Enabled.esp");
        var disabled = session.Plugins.Single(p => p.Name == "Disabled.esp");

        Assert.True(enabled.Participates);
        Assert.False(disabled.Participates);
    }

    [Fact]
    public void ImplicitMaster_AlwaysParticipates()
    {
        using var data = new PluginFixtureBuilder("gs-participation-implicit")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin("UserMod.esp")
            .Build();

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4).Opened();

        var fo4 = session.Plugins.Single(p => p.Name == "Fallout4.esm");
        Assert.True(fo4.Participates);
    }

    [Fact]
    public void AddPlugin_NewlyCreatedPlugin_Participates()
    {
        using var data = new PluginFixtureBuilder("gs-participation-add")
            .WithPlugin("Existing.esp")
            .Build();

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4).Opened();
        var newPath = Path.Combine(session.DataFolderPath, "New.esp");
        var mod = Mutagen.Bethesda.Plugins.Records.ModFactory.Activator(
            Mutagen.Bethesda.Plugins.ModKey.FromFileName("New.esp"), GameRelease.Fallout4);
        mod.WriteToBinary(newPath);

        var metadata = session.AddPlugin(newPath);

        Assert.True(metadata.Participates);
    }

    [Fact]
    public void PluginResponse_ReportsParticipationFromMetadata()
    {
        using var data = new PluginFixtureBuilder("gs-participation-response")
            .WithPlugin("Enabled.esp")
            .WithPlugin("Disabled.esp", enabled: false)
            .Build();

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4).Opened();
        var disabled = session.Plugins.Single(p => p.Name == "Disabled.esp");

        var response = PluginResponse.FromMetadata(disabled);

        Assert.False(response.Participates);
    }

    // #270: the explicit load path is the one the extension actually uses, and until now it
    // hardcoded Participates: true — so ADR-0035's loading model reached the product only through
    // the plugins.txt path nothing calls. Participation is now the caller's to state per plugin.
    [Fact]
    public void LoadExplicit_NonParticipatingPlugin_IsIndexedWithParticipatesFalse()
    {
        using var fx = new PluginFixtureBuilder("gs-participation-explicit")
            .WithPlugin("Enabled.esp")
            .WithPlugin("Disabled.esp", enabled: false)
            .BuildScattered();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4).Opened();

        Assert.True(session.Plugins.Single(p => p.Name == "Enabled.esp").Participates);
        Assert.False(session.Plugins.Single(p => p.Name == "Disabled.esp").Participates);
    }

    // ADR-0035: an implicit master is forced on — there is no plugins.txt line to carry a `*`,
    // and nothing in the explicit list can make it non-participating.
    [Fact]
    public void LoadExplicit_ImplicitMaster_AlwaysParticipates()
    {
        using var fx = new PluginFixtureBuilder("gs-participation-explicit-implicit")
            .WithPlugin("Fallout4.esm", enabled: false)
            .WithPlugin("Mod.esp")
            .BuildScattered();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4).Opened();

        Assert.True(session.Plugins.Single(p => p.Name == "Fallout4.esm").Participates);
    }
}
