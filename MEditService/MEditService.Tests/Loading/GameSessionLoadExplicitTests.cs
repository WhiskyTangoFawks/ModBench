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

        using var session = GameSession.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4).Opened();

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

        using var session = GameSession.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4).Opened();

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

        var plugins = fx.Plugins.Append(new ExplicitPluginInput("Missing.esp", "/nonexistent/path/Missing.esp", PluginOrigin.DataDirectory, true)).ToList();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, plugins, GameRelease.Fallout4).Opened();

        Assert.Contains(session.Plugins, p => p.Name == "Good.esp");
        Assert.DoesNotContain(session.Plugins, p => p.Name == "Missing.esp");
        Assert.Empty(session.LoadFailures);
    }

    [Fact]
    public void LoadExplicit_CreationClubOnlyPlugin_IsForcedImmutableAndOrdered()
    {
        using var fx = new PluginFixtureBuilder("gs-explicit-ccc")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("ccTest.esl")
            .WithPlugin("Mod.esp")
            .WithCreationClubCatalog("ccTest.esl")
            .BuildScattered();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4).Opened();

        var implicitMaster = session.Plugins.Single(p => p.Name == "Fallout4.esm");
        var cc = session.Plugins.Single(p => p.Name == "ccTest.esl");
        var mod = session.Plugins.Single(p => p.Name == "Mod.esp");

        Assert.True(cc.IsImmutable);
        Assert.True(cc.Participates);
        Assert.Equal(PluginOrigin.DataDirectory, cc.Origin);
        Assert.True(implicitMaster.LoadOrderIndex < cc.LoadOrderIndex);
        Assert.True(cc.LoadOrderIndex < mod.LoadOrderIndex);
    }

    [Fact]
    public void LoadExplicit_CreationClubPluginAlsoExplicitlyListed_LoadsOnceForcedOn()
    {
        using var fx = new PluginFixtureBuilder("gs-explicit-ccc-dup")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("ccDup.esl")
            .WithCreationClubCatalog("ccDup.esl")
            .BuildScattered();

        // Simulates plugins.txt sending its own line for a CC plugin (the repro's three
        // already-*-listed ESLs) — Mod Management resolves it to the same Data-folder physical
        // file, disabled, unaware the backend also forces it on via the .ccc catalog.
        var cccPath = Path.Combine(fx.GameDirectory, "ccDup.esl");
        var plugins = fx.Plugins.Append(new ExplicitPluginInput("ccDup.esl", cccPath, PluginOrigin.DataDirectory, Participates: false)).ToList();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, plugins, GameRelease.Fallout4).Opened();

        var matches = session.Plugins.Where(p => p.Name == "ccDup.esl").ToList();
        var cc = Assert.Single(matches);
        Assert.True(cc.IsImmutable);
        Assert.True(cc.Participates);
    }

    [Fact]
    public void LoadExplicit_CreationClubCatalogOrder_IsPreservedRegardlessOfName()
    {
        // Catalog lists ccZ before ccA — alphabetically reversed on purpose, so a wrong
        // implementation that alphabetizes or otherwise reorders the names is caught.
        using var fx = new PluginFixtureBuilder("gs-explicit-ccc-order")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("ccZ.esl")
            .WithPlugin("ccA.esl")
            .WithCreationClubCatalog("ccZ.esl", "ccA.esl")
            .BuildScattered();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4).Opened();

        var ccZ = session.Plugins.Single(p => p.Name == "ccZ.esl");
        var ccA = session.Plugins.Single(p => p.Name == "ccA.esl");
        Assert.True(ccZ.LoadOrderIndex < ccA.LoadOrderIndex);
    }

    [Fact]
    public void LoadExplicit_NoCreationClubCatalog_SessionLoadsUnaffected()
    {
        // No WithCreationClubCatalog call — no Fallout4.ccc file anywhere near the fixture.
        using var fx = new PluginFixtureBuilder("gs-explicit-no-ccc")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("Mod.esp")
            .BuildScattered();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4).Opened();

        Assert.Equal(["Fallout4.esm", "Mod.esp"], session.Plugins.Select(p => p.Name));
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
        var plugins = fx.Plugins.Append(new ExplicitPluginInput("Bad.esp", badPath, PluginOrigin.DataDirectory, true)).ToList();

        using var session = GameSession.LoadExplicit(fx.GameDirectory, plugins, GameRelease.Fallout4).Opened();

        Assert.Contains(session.Plugins, p => p.Name == "Good.esp");
        Assert.DoesNotContain(session.Plugins, p => p.Name == "Bad.esp");
        var failure = Assert.Single(session.LoadFailures);
        Assert.Equal("Bad.esp", failure.Name);
        Assert.False(string.IsNullOrWhiteSpace(failure.Reason));
    }
}
