using System.Net;
using System.Net.Http.Json;
using MEditService.Codec.Schema;
using MEditService.Http;
using MEditService.Http.Tests.Api;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.Http.Tests.RealData;

/// <summary>Against whatever real game is installed, discovered rather than hardcoded. Gated behind
/// <c>MEDIT_SMOKE=1</c>: loads full vanilla masters, so never in a normal run or under mutation.</summary>
[Collection(WebHostCollection.Name)]
public sealed class RealInstallSmokeTests
{
    private static readonly GameRelease[] CandidateGames =
    [
        GameRelease.Fallout4,
        GameRelease.SkyrimSE,
        GameRelease.Starfield,
    ];

    // Which candidates are usable is decided here, never by editing the list: a release whose Mutagen
    // assembly is not referenced is not offered, not loaded and not counted.
    private static readonly SchemaReflector SchemaReflector = new SchemaReflector();

    [SmokeFact("run the real-install smoke test")]
    public async Task DiscoveredInstalls_LoadAndIndex()
    {
        var locator = new GameLocator();
        var tested = 0;

        foreach (var release in CandidateGames)
        {
            // Skip gracefully: an unsupported release is not offered, never a crash — this
            // is discovery's own guard, checked before even looking for an install of it.
            if (!SchemaReflector.IsSupported(release))
                continue;

            if (!locator.TryGetDataDirectory(release, out var dataDir))
                continue;

            // LoadOrderSnapshot loads the implicit base masters present in the game directory, so an empty explicit
            // list exercises a real vanilla load without guessing order. The instance is a temp one: a real
            // install is not an MO2 instance.
            var instanceRoot = Path.Combine(Path.GetTempPath(), $"medit-smoke-{Guid.NewGuid():N}");
            Directory.CreateDirectory(instanceRoot);
            try
            {
                await using var app = new MEditHost();
                var client = app.CreateClient();
                client.Timeout = TimeSpan.FromMinutes(10);

                var load = await client.PutAsJsonAsync("/load-order", new
                {
                    plugins = Array.Empty<object>(),
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
