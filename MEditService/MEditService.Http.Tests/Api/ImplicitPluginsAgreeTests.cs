using MEditService.Http;
using MEditService.PluginAdapter;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>One answer, two doors, while both stand: the Plugin adapter's implicit-plugins door and
/// the endpoints' own forced-plugin list, over the same Data folder. Both go when the second copy
/// does, debt #947.</summary>
public sealed class ImplicitPluginsAgreeTests
{
    private static readonly IPluginAdapter Adapter = MutagenPluginAdapter.Instance;

    [Theory]
    [InlineData("agree-both-sources", true, true)]
    [InlineData("agree-master-only", true, false)]
    [InlineData("agree-catalog-only", false, true)]
    [InlineData("agree-neither", false, false)]
    public void TheAdaptersImplicitPlugins_AreTheForcedPluginNames(string prefix, bool master, bool cataloged)
    {
        var builder = new PluginFixtureBuilder(prefix).WithPlugin("UserMod.esp");
        if (master) builder.WithPlugin("Fallout4.esm", listed: false);
        if (cataloged) builder.WithPlugin("ccTest.esl", listed: false).WithCreationClubCatalog("ccTest.esl");
        using var data = builder.Build();

        Assert.Equal(
            ForcedPlugins.Names(data.DataFolder, GameRelease.Fallout4),
            Adapter.ImplicitPluginsIn(data.DataFolder, GameRelease.Fallout4));
    }
}
