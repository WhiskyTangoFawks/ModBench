using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class DetectExternalChangeTraceTests : HostedTests
{
    private const string Plugin = "Watched.esp";
    private const string Origin = "WatchedMod";
    private const string Npc = "WatchedNpc";

    private static ScatteredFixtureData OneMod() =>
        new PluginFixtureBuilder("trace-detect-external-change")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();

    private async Task<ScatteredFixtureData> CompiledPlugin()
    {
        var fx = Owned(OneMod());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
        await Client.NextCheck(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        return fx;
    }

    [Fact]
    public async Task APluginAnotherToolRewrote_IsNamedOnTheStream_WithItsMod_WhenTheChangeNamesItsFile()
    {
        var fx = await CompiledPlugin();
        using var stream = await Client.NotificationStream();
        var path = fx.Plugins.Single(p => p.Origin == Origin).Path;

        OtherTool.WritesThePlugin(path, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.9f);
        await Client.SignalChange(path);

        var change = (await stream.EventsUntil("external-change", NamesThePlugin))[^1];
        Assert.Equal(Origin, change.GetProperty("origin").GetString());
    }

    [Fact]
    public async Task AChangeNamingOnlyAnAsset_PublishesNothing_WhereTheNextChangeNamingNoPathPublishes()
    {
        var fx = await CompiledPlugin();
        using var stream = await Client.NotificationStream();
        var path = fx.Plugins.Single(p => p.Origin == Origin).Path;

        await Client.SignalChange(Path.Combine(Path.GetDirectoryName(path).Require(), "textures", "watched.dds"));
        OtherTool.WritesThePlugin(path, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.9f);
        await Client.SignalChange();

        Assert.True(NamesThePlugin(Assert.Single(await stream.EventsUntil("external-change", NamesThePlugin))));
    }

    private static bool NamesThePlugin(JsonElement change) =>
        change.GetProperty("changedPlugins").EnumerateArray().Any(p => p.GetProperty("name").GetString() == Plugin);
}
