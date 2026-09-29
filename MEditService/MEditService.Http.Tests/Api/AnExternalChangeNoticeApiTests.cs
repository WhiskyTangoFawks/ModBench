using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

/// <summary>ADR-0003 invariant 3 on the wire: at each settle and at load, the stream names each
/// tracked plugin whose bytes differ from what Modbench last wrote, and each untracked plugin of a
/// tracked mod.</summary>
[Collection(WebHostCollection.Name)]
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
        (await Client.Track(Plugin, Origin)).EnsureSuccessStatusCode();
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
    public async Task AnEdit_ToAPluginThatChangedOutsideModbench_Lands()
    {
        var fx = Owned(await Watched());
        var formKey = await Client.FirstFormKey(Plugin);
        using var stream = await Client.NotificationStream();
        ARelease(fx);
        await NoticesUntilOneNames(stream, Plugin);

        var response = await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.25);

        response.EnsureSuccessStatusCode();
    }

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
        (await Client.Track(Plugin, Origin)).EnsureSuccessStatusCode();
        await Client.PluginReportsTracked(Plugin);
        Restart();
        using var stream = await Client.NotificationStream();

        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();

        var untracked = Assert.Single(await stream.EventsUntil("untracked-plugins"));
        Assert.Equal(Origin, untracked.GetProperty("origin").GetString());
        Assert.Equal([SecondPlugin], untracked.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));
    }

    // The mark a compile leaves when its write never finishes.
    private static Task InterruptACompile(string modFolder) =>
        Assert.ThrowsAnyAsync<InvalidOperationException>(() => CompileJournal.RunBatchAsync(modFolder, [Plugin],
            _ => throw new InvalidOperationException("simulated crash between the mark and the binary write")));

    private static void AssertNamesThePlugin(JsonElement unfinished)
    {
        Assert.Equal(Plugin, unfinished.GetProperty("plugin").GetString());
        Assert.Equal(Origin, unfinished.GetProperty("origin").GetString());
    }

    [Fact]
    public async Task SettlingAModWhoseCompileWasInterrupted_WarnsCompileUnfinished_NamingThePlugin_AndTellsNoChange()
    {
        var fx = Owned(await Watched());
        await InterruptACompile(OtherTool.ModFolderOf(fx, Origin));
        using var stream = await Client.NotificationStream();

        ARelease(fx);

        var frames = await stream.FramesThrough("compile-unfinished", _ => true);
        AssertNamesThePlugin(frames[^1].Data);
        Assert.DoesNotContain(frames, f => f.Kind == "external-change");
    }

    [Fact]
    public async Task ALoadAfterAnInterruptedCompile_WarnsCompileUnfinished_NamingThePlugin_AndTellsNoChange()
    {
        var fx = Owned(await Watched());
        await InterruptACompile(OtherTool.ModFolderOf(fx, Origin));
        Restart();
        using var stream = await Client.NotificationStream();

        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var frames = await stream.FramesThrough("compile-unfinished", _ => true);
        AssertNamesThePlugin(frames[^1].Data);
        Assert.DoesNotContain(frames, f => f.Kind == "external-change");
    }

    // The scattered fixture gives each plugin a folder of its own, so the second is written beside
    // the first and listed by hand.
    [Fact]
    public async Task ALoadAfterAnInterruptedCompile_WarnsCompileUnfinished_WhenAnotherTrackedPluginOfTheModCannotBeRead()
    {
        var fx = Owned(OneMod());
        var secondBinary = Path.Combine(OtherTool.ModFolderOf(fx, Origin), SecondPlugin);
        OtherTool.WritesThePlugin(secondBinary, mod => mod.Npcs.AddNew("SecondNpc").HeightMax = 0.5f);
        LoadOrderEntry[] plugins =
            [.. fx.Plugins, new LoadOrderEntry(SecondPlugin, secondBinary, Origin, fx.Plugins.Count, Enabled: true, Winning: true)];
        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();
        (await Client.Track([(Plugin, Origin), (SecondPlugin, Origin)])).EnsureSuccessStatusCode();
        await Client.PluginReportsTracked(SecondPlugin);
        await InterruptACompile(OtherTool.ModFolderOf(fx, Origin));
        Restart();
        using var stream = await Client.NotificationStream();
        FileModes.Set(secondBinary, "000");
        try
        {
            (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();

            var frames = await stream.FramesThrough("compile-unfinished", _ => true);
            AssertNamesThePlugin(frames[^1].Data);
        }
        finally
        {
            FileModes.Set(secondBinary, "644");
        }
    }
}
