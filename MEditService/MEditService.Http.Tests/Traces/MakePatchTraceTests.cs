using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class MakePatchTraceTests : HostedTests
{
    private const string Base = "Base.esp";
    private const string Mod = "PatchMod";
    private const string Patch = "Patch.esp";

    [Fact]
    public async Task MakingAPluginOverAFileAtItsPath_AskedToReplaceIt_AnswersThePlugin_AndNamesTheFileSetAsideOnTheStream()
    {
        var npc = string.Empty;
        var fx = Owned(new PluginFixtureBuilder("trace-make-patch").WithPlugin(Base, mod => npc = mod.Npcs.AddNew("BaseNpc").FormKey.ToString()).BuildScattered());
        var folder = Directory.CreateDirectory(Path.Combine(fx.Root, Mod)).FullName;
        (await Client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(
            fx.DataFolder, fx.InstanceRoot, fx.Plugins, places: new[] { new { name = Mod, folder } }))).EnsureSuccessStatusCode();
        var read = (await Client.GetFromJsonAsync<JsonElement>(
            $"/plugins/{Base}/records/{Uri.EscapeDataString(npc)}/rendered-document?origin={Uri.EscapeDataString(PluginOrigin.DataDirectory)}")).GetProperty("text").GetString();
        await File.WriteAllTextAsync(Path.Combine(folder, Patch), "held");
        using var stream = await Client.NotificationStream();

        var made = await Client.PostAsJsonAsync(
            "/plugins/make-patch", new { origin = Mod, name = Patch, records = new[] { new { text = read } }, flags = Array.Empty<string>(), replace = true });

        Assert.Equal(HttpStatusCode.OK, made.StatusCode);
        var setAside = Assert.Single(await stream.EventsUntil("files-set-aside"));
        Assert.Equal(
            (Patch, folder, Patch),
            ((await made.Body()).GetProperty("plugin").GetProperty("name").GetString(), setAside.GetProperty("folder").GetString(),
                Path.GetFileName(Assert.Single(setAside.GetProperty("setAside").EnumerateArray()).GetString())));
    }
}
