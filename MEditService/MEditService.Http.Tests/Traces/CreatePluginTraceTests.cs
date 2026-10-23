using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class CreatePluginTraceTests : HostedTests
{
    private const string Origin = "PickedMod";

    private async Task<ScatteredFixtureData> Loaded()
    {
        var fx = new PluginFixtureBuilder("trace-create-plugin")
            .WithPlugin("Existing.esp", mod => mod.Npcs.AddNew("ExistingNpc"), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return fx;
    }

    private static Task<HttpResponseMessage> Create(HttpClient client, string name, string folder) =>
        client.PostAsJsonAsync("/plugins/create", new { origin = Origin, name, folder });

    [Fact]
    public async Task CreatingAPluginInASourceMod_LandsItsSourceInTheSourceFolderTheRequestNames()
    {
        var fx = Owned(await Loaded());
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        var folder = OtherTool.ModFolderOf(fx, Origin);
        var sourceFolder = Directory.CreateDirectory(Path.Combine(fx.Root, "source", Origin)).FullName;
        foreach (var entry in new[] { ".git", ".gitignore", "plugin-source" })
            Directory.Move(Path.Combine(folder, entry), Path.Combine(sourceFolder, entry));

        var created = await Client.PostAsJsonAsync("/plugins/create", new { origin = Origin, name = "New.esp", folder, sourceFolder });

        created.EnsureSuccessStatusCode();
        Assert.True(Directory.Exists(PluginSourceRoot.In(sourceFolder, "New.esp")));
    }

    private async Task<string> HeldAsTheServiceReportsIt() =>
        await Client.GetStringAsync(new Uri("/load-order/status", UriKind.Relative));

    [Fact]
    public async Task CreatingAPluginOverAFileAlreadyThere_IsRefused_AndChangesNothing()
    {
        var fx = Owned(await Loaded());
        var folder = OtherTool.ModFolderOf(fx, Origin);
        OtherTool.WritesTheFile(Path.Combine(folder, "Occupied.esp"), "not a plugin");
        var disk = TreeSnapshot.Of(fx.Root);
        var held = await HeldAsTheServiceReportsIt();

        var created = await Create(Client, "Occupied.esp", folder);

        Assert.Equal(HttpStatusCode.Conflict, created.StatusCode);
        Assert.Equal("FileExists", (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refusal").GetString());
        Assert.Equal(disk, TreeSnapshot.Of(fx.Root));
        Assert.Equal(held, await HeldAsTheServiceReportsIt());
    }

    [Fact]
    public async Task CreatingAPluginInAFolderThatHasGone_IsRefused_AndMakesNoFolder()
    {
        var fx = Owned(await Loaded());
        var gone = Path.Combine(fx.Root, "GoneMod");
        var disk = TreeSnapshot.Of(fx.Root);
        var held = await HeldAsTheServiceReportsIt();

        var created = await Create(Client, "Created.esp", gone);

        Assert.Equal(HttpStatusCode.NotFound, created.StatusCode);
        Assert.Equal("FolderGone", (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refusal").GetString());
        Assert.Equal(disk, TreeSnapshot.Of(fx.Root));
        Assert.Equal(held, await HeldAsTheServiceReportsIt());
    }
}
