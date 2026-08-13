using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Loading;

public sealed class GameSessionLoadExplicitTests
{
    [Fact]
    public void LoadExplicit_ScatteredPaths_LoadsAllPluginsInOrder()
    {
        using var fx = new PluginFixtureBuilder("gs-explicit")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        // Implicit master (from game dir) + the two scattered explicit plugins.
        Assert.Equal(["Fallout4.esm", "A.esp", "B.esp"], session.Plugins.Select(p => p.Name));
        Assert.True(session.Plugins[0].LoadOrderIndex < session.Plugins[1].LoadOrderIndex);
        Assert.True(session.Plugins[1].LoadOrderIndex < session.Plugins[2].LoadOrderIndex);
    }

    [Fact]
    public void LoadExplicit_ImplicitMasterFromGameDir_IsImmutable()
    {
        using var fx = new PluginFixtureBuilder("gs-explicit-immutable")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("Mod.esp")
            .BuildScattered();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        var master = session.Plugins.Single(p => p.Name == "Fallout4.esm");
        var mod = session.Plugins.Single(p => p.Name == "Mod.esp");
        Assert.True(master.IsImmutable);
        Assert.False(mod.IsImmutable);
    }

    [Fact]
    public void LoadExplicit_MissingPluginFile_IsWarnedAndSkipped_NotALoadFailure()
    {
        using var fx = new PluginFixtureBuilder("gs-explicit-missing")
            .WithPlugin("Good.esp", mod => mod.Npcs.AddNew("GoodNpc"))
            .BuildScattered();

        var plugins = fx.Plugins.Append(("Missing.esp", "/nonexistent/path/Missing.esp", PluginOrigin.DataDirectory, true)).ToList();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, plugins, GameRelease.Fallout4);

        Assert.Contains(session.Plugins, p => p.Name == "Good.esp");
        Assert.DoesNotContain(session.Plugins, p => p.Name == "Missing.esp");
        Assert.Empty(session.LoadFailures);
    }

    [Fact]
    public void LoadExplicit_UnparseablePlugin_IsSkippedAndReported_RestStillLoad()
    {
        using var fx = new PluginFixtureBuilder("gs-explicit-bad")
            .WithPlugin("Good.esp", mod => mod.Npcs.AddNew("GoodNpc"))
            .BuildScattered();

        // A file that exists with a plugin extension but is not a valid plugin: it must not abort the load.
        var badPath = Path.Combine(fx.Root, "Bad.esp");
        File.WriteAllText(badPath, "this is not a plugin");
        var plugins = fx.Plugins.Append(("Bad.esp", badPath, PluginOrigin.DataDirectory, true)).ToList();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, plugins, GameRelease.Fallout4);

        Assert.Contains(session.Plugins, p => p.Name == "Good.esp");
        Assert.DoesNotContain(session.Plugins, p => p.Name == "Bad.esp");
        var failure = Assert.Single(session.LoadFailures);
        Assert.Equal("Bad.esp", failure.Name);
        Assert.False(string.IsNullOrWhiteSpace(failure.Reason));
    }
}
