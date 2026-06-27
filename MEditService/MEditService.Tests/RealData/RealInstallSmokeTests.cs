using System.Net;
using System.Net.Http.Json;
using MEditService.Core.Queries;
using Microsoft.AspNetCore.Mvc.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;

namespace MEditService.Tests.RealData;

/// <summary>
/// End-to-end smoke test against whatever real Bethesda game(s) are installed on this machine.
/// Installs are discovered (no hardcoded paths) so this also generalizes to other games as
/// multi-game support lands — add a <see cref="GameRelease"/> to <see cref="CandidateGames"/>.
///
/// Environment-dependent and slow (loads full vanilla masters), so it is gated behind
/// <c>MEDIT_SMOKE=1</c>: it never runs in normal <c>dotnet test</c> or under mutation (where it
/// would otherwise re-load hundreds of MB per mutant). Run it deliberately:
///   MEDIT_SMOKE=1 dotnet test --filter FullyQualifiedName~RealInstallSmokeTests
/// </summary>
public sealed class RealInstallSmokeTests
{
    private static readonly GameRelease[] CandidateGames =
    [
        GameRelease.Fallout4,
        GameRelease.SkyrimSE,
        GameRelease.Starfield,
    ];

    [Fact]
    public async Task DiscoveredInstalls_LoadAndIndex()
    {
        if (Environment.GetEnvironmentVariable("MEDIT_SMOKE") != "1")
            return; // self-excluded from normal/mutation runs; run explicitly with MEDIT_SMOKE=1

        var locator = new GameLocator();
        var tested = 0;

        foreach (var release in CandidateGames)
        {
            if (!locator.TryGetDataDirectory(release, out var dataDir))
                continue;

            // GameSession loads the implicit base masters present in the data folder, so an empty
            // Plugins.txt is enough to exercise a real vanilla load without guessing load order.
            var pluginsTxt = Path.Combine(Path.GetTempPath(), $"medit-smoke-{Guid.NewGuid():N}.txt");
            await File.WriteAllTextAsync(pluginsTxt, "");
            try
            {
                await using var app = new WebApplicationFactory<Program>();
                var client = app.CreateClient();
                client.Timeout = TimeSpan.FromMinutes(10);

                var load = await client.PostAsJsonAsync("/session/load", new
                {
                    dataFolderPath = dataDir.Path,
                    pluginsTxtPath = pluginsTxt,
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
                File.Delete(pluginsTxt);
            }
        }

        Assert.True(tested > 0,
            "MEDIT_SMOKE=1 was set but no supported game install was discovered to smoke-test.");
    }
}
