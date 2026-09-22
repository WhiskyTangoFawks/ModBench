using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

/// <summary>The plugins an install loads with no load-order line of its own (ADR-0013 invariant
/// 2), read off a real Data folder: the release's implicit masters that are present, then that
/// folder's Creation Club catalog.</summary>
public sealed class ImplicitPluginsTests
{
    private const string UserPlugin = "UserMod.esp";

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    [Fact]
    public void ImplicitPluginsIn_AreTheImplicitMastersOnDisk_ThenTheCreationClubCatalog()
    {
        using var data = new PluginFixtureBuilder("adapter-implicit-names")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin("ccTest.esl", listed: false)
            .WithPlugin(UserPlugin)
            .WithCreationClubCatalog("ccTest.esl")
            .Build();

        Assert.Equal(
            ["Fallout4.esm", "ccTest.esl"],
            Adapter.ImplicitPluginsIn(data.DataFolder, GameRelease.Fallout4));
    }

    // A plugin sitting in Data is not thereby implicit: only the release's own list and the Creation
    // Club catalog put a name here, so a mod-deployed file still needs its line.
    [Fact]
    public void ImplicitPluginsIn_OmitAPluginNeitherSourceClaims()
    {
        using var data = new PluginFixtureBuilder("adapter-implicit-unclaimed")
            .WithPlugin(UserPlugin, listed: false)
            .Build();

        Assert.DoesNotContain(UserPlugin, Adapter.ImplicitPluginsIn(data.DataFolder, GameRelease.Fallout4));
    }

    [Fact]
    public void ImplicitPluginsIn_OmitAnImplicitMasterMissingFromDisk()
    {
        using var data = new PluginFixtureBuilder("adapter-implicit-missing")
            .WithPlugin("Fallout4.esm", listed: false)
            .Build();

        Assert.Equal(["Fallout4.esm"], Adapter.ImplicitPluginsIn(data.DataFolder, GameRelease.Fallout4));
    }

    [Fact]
    public void ImplicitPluginsIn_NameAPluginBothSourcesClaimOnce()
    {
        using var data = new PluginFixtureBuilder("adapter-implicit-both")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithCreationClubCatalog("Fallout4.esm")
            .Build();

        Assert.Equal(["Fallout4.esm"], Adapter.ImplicitPluginsIn(data.DataFolder, GameRelease.Fallout4));
    }

    // The catalog names what the install shipped, and the install may have removed it; a stale entry
    // contributes no name.
    [Fact]
    public void ImplicitPluginsIn_OmitACatalogedPluginMissingFromDisk()
    {
        using var data = new PluginFixtureBuilder("adapter-implicit-stale")
            .WithPlugin(UserPlugin)
            .WithCreationClubCatalog("ccGone.esl")
            .Build();

        Assert.Empty(Adapter.ImplicitPluginsIn(data.DataFolder, GameRelease.Fallout4));
    }

    [Fact]
    public void ImplicitPluginsIn_ForAFolderWithNoCatalogAndNoMasters_IsEmpty()
    {
        using var data = new PluginFixtureBuilder("adapter-implicit-bare").Build();

        Assert.Empty(Adapter.ImplicitPluginsIn(data.DataFolder, GameRelease.Fallout4));
    }
}
