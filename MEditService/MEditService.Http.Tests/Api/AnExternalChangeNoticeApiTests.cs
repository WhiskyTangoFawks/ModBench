using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class AnExternalChangeNoticeApiTests : HostedTests
{
    private const string Plugin = "Watched.esp";
    private const string SecondPlugin = "WatchedToo.esp";
    private const string Origin = "WatchedMod";
    private const string Npc = "WatchedNpc";

    private static ScatteredFixtureData OneMod() =>
        new PluginFixtureBuilder("trace-external-change-notice")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();

    private async Task<ScatteredFixtureData> Watched()
    {
        var fx = OneMod();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(Plugin);
        return fx;
    }

    private static string PluginPath(ScatteredFixtureData fx) => fx.Plugins.Single(p => p.Origin == Origin).Path;

    private static void ARelease(ScatteredFixtureData fx) =>
        OtherTool.WritesThePlugin(PluginPath(fx), mod => mod.Npcs.AddNew(Npc).HeightMax = 0.9f);

    private static IEnumerable<(string? Name, string? BytesSha256)> ChangedPlugins(JsonElement notice) =>
        notice.GetProperty("changedPlugins").EnumerateArray()
            .Select(p => (p.GetProperty("name").GetString(), p.GetProperty("bytesSha256").GetString()));

    private static Task<IReadOnlyList<JsonElement>> NoticesUntilOneNames(StreamReader stream, string plugin) =>
        stream.EventsUntil("external-change", notice => ChangedPlugins(notice).Any(p => p.Name == plugin));

    [Fact]
    public async Task AChangeMadeWhileTheServiceWasDown_IsNamedAtTheNextLoad_WithTheStateOfItsBytes()
    {
        var fx = Owned(await Watched());
        Restart();
        ARelease(fx);
        using var stream = await Client.NotificationStream();

        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var notice = (await NoticesUntilOneNames(stream, Plugin))[^1];
        Assert.Equal(Origin, notice.GetProperty("origin").GetString());
        Assert.Equal(
            [(Plugin, Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(PluginPath(fx)))))],
            ChangedPlugins(notice));
    }

    [Fact]
    public async Task ATrackedPluginWhoseBinaryCannotBeRead_FailsToLoad_AndIsNamedWithNoState()
    {
        var fx = Owned(await Watched());
        var binary = PluginPath(fx);
        Restart();
        using var stream = await Client.NotificationStream();
        FileModes.Set(binary, "000");
        try
        {
            (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

            var notice = (await NoticesUntilOneNames(stream, Plugin))[^1];
            Assert.Equal([(Plugin, (string?)null)], ChangedPlugins(notice));
            var status = await Client.GetFromJsonAsync<JsonElement>("/load-order/status");
            var failure = Assert.Single(status.GetProperty("failures").EnumerateArray());
            Assert.Equal((Plugin, Origin), (failure.GetProperty("name").GetString(), failure.GetProperty("origin").GetString()));
        }
        finally
        {
            FileModes.Set(binary, "644");
        }
    }

    [Fact]
    public async Task ATrackedModsUntrackedPlugin_IsNamedAtLoad()
    {
        var fx = Owned(OneMod());
        var second = Path.Combine(OtherTool.ModFolderOf(fx, Origin), SecondPlugin);
        OtherTool.WritesThePlugin(second, mod => mod.Npcs.AddNew("SecondNpc").HeightMax = 0.5f);
        LoadOrderEntry[] plugins =
            [.. fx.Plugins, new LoadOrderEntry(SecondPlugin, second, Origin, fx.Plugins.Count, Enabled: true, Winning: true)];
        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();
        await Client.PluginReportsTracked(Plugin);
        Restart();
        using var stream = await Client.NotificationStream();

        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();

        var untracked = Assert.Single(await stream.EventsUntil("untracked-plugins"));
        Assert.Equal(Origin, untracked.GetProperty("origin").GetString());
        Assert.Equal([SecondPlugin], untracked.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));
    }
}
