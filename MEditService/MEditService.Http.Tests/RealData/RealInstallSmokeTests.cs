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

public sealed class RealInstallSmokeTests(RealInstallSmokeTests.OneGameLoadedAtATime install)
    : IClassFixture<RealInstallSmokeTests.OneGameLoadedAtATime>
{
    private static readonly GameRelease[] CandidateGames =
    [
        GameRelease.Fallout4,
        GameRelease.SkyrimSE,
        GameRelease.Starfield,
    ];

    public static TheoryData<GameRelease, string> InstalledMasters()
    {
        var rows = new TheoryData<GameRelease, string>();
        foreach (var release in CandidateGames.Where(IsReferenced))
        {
            if (!new GameLocator().TryGetDataDirectory(release, out var dataDir)) continue;
            foreach (var master in MastersIn(release, dataDir.Path)) rows.Add(release, master);
        }
        return rows;
    }

    [SmokeTheory("run the real-install smoke test")]
    [MemberData(nameof(InstalledMasters))]
    public async Task AnInstalledMaster_IsListedAndItsRecordsRead(GameRelease release, string master)
    {
        var client = await install.LoadedWithItsMasters(release);

        var plugins = await client.GetFromJsonAsync<List<JsonElement>>("/plugins") ?? [];
        var types = await client.GetFromJsonAsync<List<JsonElement>>(
            $"/plugins/{Uri.EscapeDataString(master)}/record-types?origin={Uri.EscapeDataString(PluginOrigin.DataDirectory)}");

        Assert.Contains(master, plugins.Select(p => p.GetProperty("name").GetString()));
        Assert.True(types is { Count: > 0 }, $"{release}: {master} is listed from its header, but none of its records was read.");
    }

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

    internal static List<string> MastersIn(GameRelease release, string dataDir) =>
    [
        .. Implicits.Get(release).Listings
            .Select(master => master.FileName.String)
            .Where(name => File.Exists(Path.Combine(dataDir, name))),
    ];

    public sealed class OneGameLoadedAtATime : IAsyncLifetime, IAsyncDisposable
    {
        private static readonly TimeSpan LongerThanStarfieldsMastersTakeToIndex = TimeSpan.FromMinutes(30);

        private GameRelease? _release;
        private ScratchDirectory? _instanceRoot;
        private MEditHost? _host;
        private HttpClient? _client;

        public async Task<HttpClient> LoadedWithItsMasters(GameRelease release)
        {
            if (_release == release && _client is { } held) return held;
            await DisposeAsync();

            if (!new GameLocator().TryGetDataDirectory(release, out var dataDir))
                throw new InvalidOperationException($"{release} has a row but no install.");
            var entries = MastersIn(release, dataDir.Path)
                .Select((name, line) => new LoadOrderEntry(name, Path.Combine(dataDir.Path, name), PluginOrigin.DataDirectory, line, Enabled: true, Winning: true))
                .ToList();
            _instanceRoot = new ScratchDirectory("medit-smoke-");
            _host = new MEditHost();
            var client = _host.CreateClient();
            client.Timeout = LongerThanStarfieldsMastersTakeToIndex;

            var load = await client.PutLoadOrderAndAwaitReady(
                SnapshotPlugins.Body(dataDir.Path, _instanceRoot.Path, entries, release.ToString()), LongerThanStarfieldsMastersTakeToIndex);
            Assert.True(load.StatusCode == HttpStatusCode.OK,
                $"{release}: PUT /load-order answered {load.StatusCode}: {await load.Content.ReadAsStringAsync()}");
            (_release, _client) = (release, client);
            return client;
        }

        public Task InitializeAsync() => Task.CompletedTask;

        async ValueTask IAsyncDisposable.DisposeAsync() => await DisposeAsync();

        public async Task DisposeAsync()
        {
            _client?.Dispose();
            if (_host is not null) await _host.DisposeAsync();
            _instanceRoot?.Dispose();
            (_release, _client, _host, _instanceRoot) = (null, null, null, null);
        }
    }
}
