using System.Net;
using System.Net.Http.Json;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
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

    // #445: which of the candidates above are actually usable is decided here, never by editing
    // this list — a release whose Mutagen record-type assembly isn't referenced (true for every
    // entry above except Fallout4 in this build) is not offered, not loaded, and not counted
    // towards `tested` below. SchemaReflector.IsSupported logs the skip warning itself.
    private static readonly SchemaReflector SchemaReflector = new SchemaReflector();

    /// <summary>
    /// Marks the smoke test skipped (not passed) unless <c>MEDIT_SMOKE=1</c>, so normal and
    /// mutation runs report an honest "skipped" rather than a green no-op.
    /// </summary>
    private sealed class SmokeFactAttribute : FactAttribute
    {
        public SmokeFactAttribute()
        {
            if (Environment.GetEnvironmentVariable("MEDIT_SMOKE") != "1")
                Skip = "Set MEDIT_SMOKE=1 to run the real-install smoke test.";
        }
    }

    [SmokeFact]
    public async Task DiscoveredInstalls_LoadAndIndex()
    {
        var locator = new GameLocator();
        var tested = 0;

        foreach (var release in CandidateGames)
        {
            // Skip gracefully (#445): an unsupported release is not offered, never a crash — this
            // is discovery's own guard, checked before even looking for an install of it.
            if (!SchemaReflector.IsSupported(release))
                continue;

            if (!locator.TryGetDataDirectory(release, out var dataDir))
                continue;

            // LoadOrder loads the implicit base masters present in the game directory, so an
            // empty explicit list is enough to exercise a real vanilla load without guessing load
            // order. #592: the index needs an instance to live in — a temp one, since a real
            // install is not an MO2 instance and this test must not write into one.
            var instanceRoot = Path.Combine(Path.GetTempPath(), $"medit-smoke-{Guid.NewGuid():N}");
            Directory.CreateDirectory(instanceRoot);
            try
            {
                await using var app = new WebApplicationFactory<Program>();
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
