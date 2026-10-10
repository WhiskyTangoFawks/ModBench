using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
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

    private static bool IsReferenced(GameRelease release)
    {
        try
        {
            SharedSchemaReflector.Instance.GetSchemas(release);
            return true;
        }
        catch (UnsupportedGameReleaseException)
        {
            return false;
        }
    }

    [SmokeFact("run the real-install smoke test")]
    public async Task DiscoveredInstalls_LoadAndIndex()
    {
        var locator = new GameLocator();
        var tested = 0;

        foreach (var release in CandidateGames)
        {
            if (!IsReferenced(release))
                continue;

            if (!locator.TryGetDataDirectory(release, out var dataDir))
                continue;

            await LoadsAndIndexes(release, dataDir.Path);
            tested++;
        }

        Assert.True(tested > 0,
            "MEDIT_SMOKE=1 was set but no supported game install was discovered to smoke-test.");
    }

    private static async Task LoadsAndIndexes(GameRelease release, string dataDir)
    {
        var masters = Implicits.Get(release).Listings
            .Select(master => master.FileName.String)
            .Where(name => File.Exists(Path.Combine(dataDir, name)))
            .ToList();
        var entries = masters
            .Select((name, line) => new LoadOrderEntry(name, Path.Combine(dataDir, name), PluginOrigin.DataDirectory, line, Enabled: true, Winning: true))
            .ToList();
        using var instanceRoot = new ScratchDirectory("medit-smoke-");
        await using var app = new MEditHost();
        var client = app.CreateClient();
        client.Timeout = TimeSpan.FromMinutes(10);

        var load = await client.PutLoadOrderAndAwaitReady(
            SnapshotPlugins.Body(dataDir, instanceRoot.Path, entries, release.ToString()), TimeSpan.FromMinutes(10));
        Assert.True(load.StatusCode == HttpStatusCode.OK,
            $"{release}: PUT /load-order answered {load.StatusCode}: {await load.Content.ReadAsStringAsync()}");

        var plugins = await client.GetFromJsonAsync<List<JsonElement>>("/plugins");
        Assert.Equal(masters.Order(StringComparer.Ordinal), plugins?.Select(p => p.GetProperty("name").GetString()).Order(StringComparer.Ordinal));

        foreach (var name in masters)
        {
            var types = await client.GetFromJsonAsync<List<JsonElement>>(
                $"/plugins/{Uri.EscapeDataString(name)}/record-types?origin={Uri.EscapeDataString(PluginOrigin.DataDirectory)}");
            Assert.True(types is { Count: > 0 }, $"{release}: {name} is listed from its header, but none of its records was read.");
        }
    }
}
