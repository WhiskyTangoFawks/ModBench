using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

/// <summary>
/// Integration tests against the real vanilla Fallout 4 install.
/// Requires the game to be installed at the hard-coded Steam path.
///
/// Note: FO4 post-NextGen update does NOT write base ESMs to Plugins.txt —
/// the engine loads them automatically. We therefore supply a synthetic
/// Plugins.txt with the canonical vanilla load order. This is not a guess;
/// the ESM order is fixed by the game and well-known in the modding community.
/// MO2 users will have a real Plugins.txt that supersedes this.
/// </summary>
public sealed class RealGameLoadTests : IDisposable
{
    private const string DataFolder =
        "/home/wayne/.steam/debian-installation/steamapps/common/Fallout 4/Data";

    // Canonical vanilla load order. FO4 engine enforces this ordering internally.
    private static readonly string VanillaPluginsTxt = string.Join("\n",
        "*Fallout4.esm",
        "*DLCRobot.esm",
        "*DLCworkshop01.esm",
        "*DLCCoast.esm",
        "*DLCworkshop02.esm",
        "*DLCworkshop03.esm",
        "*DLCNukaWorld.esm");

    private const int VanillaPluginCount = 7;

    private readonly string _pluginsTxtPath;

    public RealGameLoadTests()
    {
        _pluginsTxtPath = Path.Combine(Path.GetTempPath(), $"medit-real-{Guid.NewGuid():N}.txt");
        File.WriteAllText(_pluginsTxtPath, VanillaPluginsTxt);
    }

    public void Dispose() => File.Delete(_pluginsTxtPath);

    [Fact]
    public async Task PostSessionLoad_VanillaPlugins_Returns200()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();
        client.Timeout = TimeSpan.FromMinutes(10);

        var response = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = DataFolder,
            pluginsTxtPath = _pluginsTxtPath,
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task PostSessionLoad_VanillaPlugins_ThenGetPlugins_ReturnsAllSevenEsms()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();
        client.Timeout = TimeSpan.FromMinutes(10);

        var load = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = DataFolder,
            pluginsTxtPath = _pluginsTxtPath,
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        var plugins = await client.GetFromJsonAsync<List<dynamic>>("/plugins");

        Assert.NotNull(plugins);
        Assert.Equal(VanillaPluginCount, plugins.Count);
    }
}
