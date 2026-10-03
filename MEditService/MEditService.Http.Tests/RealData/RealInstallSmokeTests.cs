using System.Net;
using System.Net.Http.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.RealData;

public sealed class RealInstallSmokeTests
{
    private static readonly GameRelease[] CandidateGames =
    [
        GameRelease.Fallout4,
        GameRelease.SkyrimSE,
        GameRelease.Starfield,
    ];

    private static readonly SchemaReflector ReleaseSupportProbe = new SchemaReflector();

    [SmokeFact("run the real-install smoke test")]
    public async Task DiscoveredInstalls_LoadAndIndex()
    {
        var locator = new GameLocator();
        var tested = 0;

        foreach (var release in CandidateGames)
        {
            if (!ReleaseSupportProbe.IsSupported(release))
                continue;

            if (!locator.TryGetDataDirectory(release, out var dataDir))
                continue;

            var masters = Implicits.Get(release).Listings
                .Select(master => master.FileName.String)
                .Where(name => File.Exists(Path.Combine(dataDir.Path, name)))
                .ToList();
            var instanceRoot = Path.Combine(Path.GetTempPath(), $"medit-smoke-{Guid.NewGuid():N}");
            Directory.CreateDirectory(instanceRoot);
            try
            {
                await using var app = new MEditHost();
                var client = app.CreateClient();
                client.Timeout = TimeSpan.FromMinutes(10);

                var load = await client.PutAsJsonAsync("/load-order", new
                {
                    plugins = masters.Select(name => new { name, path = Path.Combine(dataDir.Path, name), origin = PluginOrigin.DataDirectory }),
                    active = masters.Select(name => new PluginAddress(name, PluginOrigin.DataDirectory)),
                    loadedWithNoLine = masters.Select(name => new PluginAddress(name, PluginOrigin.DataDirectory)),
                    gameDirectory = dataDir.Path,
                    instanceRoot,
                    gameRelease = release.ToString(),
                });
                Assert.Equal(HttpStatusCode.OK, load.StatusCode);

                var plugins = await client.GetFromJsonAsync<List<PluginResponse>>("/plugins");
                Assert.NotNull(plugins);
                Assert.NotEmpty(plugins);
                tested++;
            }
            finally
            {
                Directory.Delete(instanceRoot, recursive: true);
            }
        }

        Assert.True(tested > 0,
            "MEDIT_SMOKE=1 was set but no supported game install was discovered to smoke-test.");
    }
}
