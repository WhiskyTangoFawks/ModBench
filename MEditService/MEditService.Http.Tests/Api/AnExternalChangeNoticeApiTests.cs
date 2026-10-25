using System.Net.Http.Json;
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
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        return fx;
    }

    private static string PluginPath(ScatteredFixtureData fx) => fx.Plugins.Single(p => p.Origin == Origin).Path;

    [PosixFact]
    public async Task ACompiledPluginWhoseBinaryCannotBeRead_FailsToLoad_NamedInTheLoadOrdersStatus()
    {
        var fx = Owned(await Watched());
        var binary = PluginPath(fx);
        Restart();
        FileModes.Set(binary, "000");
        try
        {
            (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

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
    public async Task ASourceModsPluginWithUnreadableSource_IsNamedAtLoad()
    {
        var fx = Owned(OneMod());
        var second = Path.Combine(OtherTool.ModFolderOf(fx, Origin), SecondPlugin);
        LoadOrderEntry[] plugins =
            [.. fx.Plugins, new LoadOrderEntry(SecondPlugin, second, Origin, fx.Plugins.Count, Enabled: true, Winning: true)];
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        OtherTool.WritesThePlugin(second, mod => mod.Npcs.AddNew("SecondNpc").HeightMax = 0.5f);
        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();
        await Client.PluginReportsCompiledPlugin(Plugin);
        Restart();
        using var stream = await Client.NotificationStream();

        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();

        var nonCompiledPlugin = Assert.Single(await stream.EventsUntil("plugin-source-unreadable"));
        Assert.Equal(Origin, nonCompiledPlugin.GetProperty("origin").GetString());
        var unreadable = Assert.Single(nonCompiledPlugin.GetProperty("pluginWithUnreadableSources").EnumerateArray());
        Assert.Equal(SecondPlugin, unreadable.GetProperty("name").GetString());
    }
}
