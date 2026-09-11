using MEditService.Api;
using MEditService.Core.Plugins;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

// ADR-0044: the forced plugins are the service's one directory read for a snapshot, and the
// composition that puts them ahead of the entries Mod Management sent.
public sealed class ForcedPluginsTests
{
    private const string UserPlugin = "UserMod.esp";

    // ── Names ───────────────────────────────────────────────────────────────────

    [Fact]
    public void Names_AreTheImplicitMastersOnDisk_ThenTheCreationClubCatalog()
    {
        using var data = new PluginFixtureBuilder("forced-names")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin("ccTest.esl", listed: false)
            .WithPlugin(UserPlugin)
            .WithCreationClubCatalog("ccTest.esl")
            .Build();

        var names = ForcedPlugins.Names(data.DataFolder, GameRelease.Fallout4);

        Assert.Equal(["Fallout4.esm", "ccTest.esl"], names);
    }

    // A plugin sitting in Data is not thereby forced: only the release's implicit list and the
    // Creation Club catalog put a name here, so a mod-deployed file still needs its line.
    [Fact]
    public void Names_OmitAPluginNeitherSourceClaims()
    {
        using var data = new PluginFixtureBuilder("forced-names-unclaimed")
            .WithPlugin(UserPlugin, listed: false)
            .Build();

        Assert.DoesNotContain(UserPlugin, ForcedPlugins.Names(data.DataFolder, GameRelease.Fallout4));
    }

    [Fact]
    public void Names_OmitAnImplicitMasterMissingFromDisk()
    {
        using var data = new PluginFixtureBuilder("forced-names-missing")
            .WithPlugin("Fallout4.esm", listed: false)
            .Build();

        Assert.Equal(["Fallout4.esm"], ForcedPlugins.Names(data.DataFolder, GameRelease.Fallout4));
    }

    // ── Prepend ─────────────────────────────────────────────────────────────────

    [Fact]
    public void Prepend_ImplicitMaster_IsForcedFirst_AndSnapshotSlotsAreOffsetPastIt()
    {
        using var data = new PluginFixtureBuilder("lo-implicit")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin(UserPlugin)
            .Build();

        var copies = ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var fo4 = copies.Single(p => p.Name.Equals("Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        var user = copies.Single(p => p.Name == UserPlugin);
        Assert.True(fo4.IsForced);
        Assert.Equal(PluginOrigin.DataDirectory, fo4.Origin);
        Assert.Equal(Path.Combine(data.DataFolder, "Fallout4.esm"), fo4.Path);
        Assert.True(fo4.Registration.Participates);
        Assert.False(user.IsForced);
        Assert.Equal(0, fo4.Registration.LoadOrderIndex);
        Assert.Equal(1, user.Registration.LoadOrderIndex);
    }

    [Fact]
    public void Prepend_ImplicitMasterAlsoInTheSnapshot_IsCopiedOnce_ForcedOn()
    {
        using var data = new PluginFixtureBuilder("lo-dedup")
            .WithPlugin("Fallout4.esm")
            .Build();

        var copies = ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var fo4 = Assert.Single(copies, p => p.Name.Equals("Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        Assert.True(fo4.IsForced);
    }

    [Fact]
    public void Prepend_ImplicitMasterMissingFromDisk_IsNotCopied()
    {
        using var data = new PluginFixtureBuilder("lo-missing-implicit")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin(UserPlugin)
            .Build();

        var copies = ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        Assert.DoesNotContain(copies, p => p.Name.Equals("DLCRobot.esm", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Prepend_CreationClubOnlyPlugin_IsForcedAfterImplicitMastersAndBeforeTheSnapshot()
    {
        using var data = new PluginFixtureBuilder("lo-ccc")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin("ccTest.esl", listed: false)
            .WithPlugin(UserPlugin)
            .WithCreationClubCatalog("ccTest.esl")
            .Build();

        var copies = ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var implicitMaster = copies.Single(p => p.Name.Equals("Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        var cc = copies.Single(p => p.Name == "ccTest.esl");
        var user = copies.Single(p => p.Name == UserPlugin);
        Assert.True(cc.IsForced);
        Assert.True(cc.Registration.Participates);
        Assert.Equal(PluginOrigin.DataDirectory, cc.Origin);
        Assert.True(implicitMaster.Registration.LoadOrderIndex < cc.Registration.LoadOrderIndex);
        Assert.True(cc.Registration.LoadOrderIndex < user.Registration.LoadOrderIndex);
    }

    [Fact]
    public void Prepend_CreationClubPluginAlsoInTheSnapshot_IsCopiedOnce_ForcedOn()
    {
        using var data = new PluginFixtureBuilder("lo-ccc-dedup")
            .WithPlugin("ccDup.esl")
            .WithCreationClubCatalog("ccDup.esl")
            .Build();

        var copies = ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var cc = Assert.Single(copies, p => p.Name == "ccDup.esl");
        Assert.True(cc.IsForced);
    }

    [Fact]
    public void Prepend_CreationClubCatalogOrder_IsPreservedRegardlessOfName()
    {
        using var data = new PluginFixtureBuilder("lo-ccc-order")
            .WithPlugin("ccZebra.esl", listed: false)
            .WithPlugin("ccAlpha.esl", listed: false)
            .WithCreationClubCatalog("ccZebra.esl", "ccAlpha.esl")
            .Build();

        var copies = ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var zebra = copies.Single(p => p.Name == "ccZebra.esl");
        var alpha = copies.Single(p => p.Name == "ccAlpha.esl");
        Assert.True(zebra.Registration.LoadOrderIndex < alpha.Registration.LoadOrderIndex);
    }

    [Fact]
    public void Prepend_NameBothForcedSourcesClaim_IsCopiedExactlyOnce()
    {
        using var data = new PluginFixtureBuilder("forced-both-sources")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithCreationClubCatalog("Fallout4.esm")
            .Build();

        var copies = ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var fo4 = Assert.Single(copies, p => p.Name.Equals("Fallout4.esm", StringComparison.OrdinalIgnoreCase));
        Assert.True(fo4.IsForced);
        Assert.Equal(0, fo4.Registration.LoadOrderIndex);
    }

    [Fact]
    public void Prepend_SnapshotFacts_CarryThrough()
    {
        using var data = new PluginFixtureBuilder("lo-facts")
            .WithPlugin("A.esp")
            .Build();
        var entries = new List<LoadOrderEntry>
        {
            new("A.esp", Path.Combine(data.DataFolder, "A.esp"), "ModA", Slot: 3, Enabled: false, Winning: true),
            new("A.esp", Path.Combine(data.DataFolder, "A.esp"), "ModB", Slot: null, Enabled: true, Winning: false),
        };

        var copies = ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, entries);

        var a = copies.Single(p => p.Origin == "ModA");
        var b = copies.Single(p => p.Origin == "ModB");
        Assert.Equal(new Registration(3, Enabled: false, Winning: true), a.Registration);
        Assert.Equal(new Registration(null, Enabled: true, Winning: false), b.Registration);
    }

    // Nothing forced on disk means nothing prepended and no slot offset: the entries are the copies.
    [Fact]
    public void Prepend_NothingForcedOnDisk_LeavesTheEntriesAsTheyWereSent()
    {
        using var data = new PluginFixtureBuilder("lo-nothing-forced")
            .WithPlugin(UserPlugin)
            .Build();

        var copies = ForcedPlugins.Prepend(data.DataFolder, GameRelease.Fallout4, data.Plugins);

        var user = Assert.Single(copies);
        Assert.Equal(UserPlugin, user.Name);
        Assert.False(user.IsForced);
        Assert.Equal(0, user.Registration.LoadOrderIndex);
    }
}
