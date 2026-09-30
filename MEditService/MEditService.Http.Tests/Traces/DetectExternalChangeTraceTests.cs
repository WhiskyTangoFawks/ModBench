using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

/// <summary>detect-external-change: another tool rewrites a tracked plugin, the mod settles, and
/// the notification stream names the mod and the plugin that changed outside Modbench.</summary>
[Collection(WebHostCollection.Name)]
public sealed class DetectExternalChangeTraceTests : HostedTests
{
    private const string Plugin = "Watched.esp";
    private const string Origin = "WatchedMod";
    private const string Npc = "WatchedNpc";

    private static ScatteredFixtureData OneMod() =>
        new PluginFixtureBuilder("trace-detect-external-change")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();

    private async Task<ScatteredFixtureData> Tracked()
    {
        var fx = Owned(OneMod());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Plugin, Origin)).EnsureSuccessStatusCode();
        await Client.PluginReportsTracked(Plugin);
        return fx;
    }

    [Fact]
    public async Task APluginAnotherToolRewrote_IsNamedOnTheStream_WithItsMod()
    {
        var fx = await Tracked();
        using var stream = await Client.NotificationStream();

        OtherTool.WritesThePlugin(
            fx.Plugins.Single(p => p.Origin == Origin).Path,
            mod => mod.Npcs.AddNew(Npc).HeightMax = 0.9f);

        var change = (await stream.EventsUntil("external-change", NamesThePlugin))[^1];
        Assert.Equal(Origin, change.GetProperty("origin").GetString());
    }

    private static bool NamesThePlugin(JsonElement change) =>
        change.GetProperty("changedPlugins").EnumerateArray().Any(p => p.GetProperty("name").GetString() == Plugin);
}
