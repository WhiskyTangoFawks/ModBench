using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class PluginFilePathsApiTests : HostedTests
{
    private const string Plugin = "Names.esp";
    private const string Origin = "NamingMod";

    [Fact]
    public async Task GetPluginFilePaths_ACompiledPluginNamingAFile_AnswersItsPathInTheDataFolder_OnTheFileHoldingTheRecord()
    {
        var fx = Owned(new PluginFixtureBuilder("api-plugin-file-paths")
            .WithPlugin(Plugin, mod => mod.TextureSets.AddNew("Holder").Diffuse = @"Decals\Stain_d.dds", origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
        await Client.NextCheck(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);

        var answer = await Client.Asked($"/plugins/file-paths?plugin={Plugin}&origin={Origin}");

        var plugin = Assert.Single(answer.EnumerateArray());
        Assert.Equal((Plugin, Origin), (plugin.GetProperty("plugin").GetProperty("name").GetString(), plugin.GetProperty("plugin").GetProperty("origin").GetString()));
        var path = Assert.Single(plugin.GetProperty("paths").EnumerateArray());
        Assert.Equal(await Client.FirstFormKey(Plugin, Origin, "txst"), path.GetProperty("formKey").GetString());
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Name == Plugin).Path).Require();
        Assert.True(File.Exists(Path.Combine(modFolder, path.GetProperty("sourceRelativePath").GetString().Require())));
    }
}
