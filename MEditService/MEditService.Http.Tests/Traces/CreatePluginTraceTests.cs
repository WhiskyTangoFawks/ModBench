using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

/// <summary>create-plugin: the new file's header flags, records and masters, or the refusal and no
/// file. Nothing else on disk or in the held snapshot changes.</summary>
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

    // Read off the host's own holder: the Index reconciles a change later, so no read over the wire
    // shows one at once.
    private (LoadOrderSnapshot Snapshot, long Version) Held()
    {
        var holder = Services.GetRequiredService<LoadOrderHolder>();
        return (holder.Current, holder.Version);
    }

    [Fact]
    public async Task CreatingAPluginOverAFileAlreadyThere_IsRefused_AndChangesNothing()
    {
        var fx = Owned(await Loaded());
        var folder = OtherTool.ModFolderOf(fx, Origin);
        OtherTool.WritesTheFile(Path.Combine(folder, "Occupied.esp"), "not a plugin");
        var disk = TreeSnapshot.Of(fx.Root);
        var held = Held();

        var created = await Create(Client, "Occupied.esp", folder);

        Assert.Equal(HttpStatusCode.Conflict, created.StatusCode);
        Assert.Equal("FileExists", (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refusal").GetString());
        Assert.Equal(disk, TreeSnapshot.Of(fx.Root));
        Assert.Equal(held, Held());
    }

    [Fact]
    public async Task CreatingAPluginInAFolderThatHasGone_IsRefused_AndMakesNoFolder()
    {
        var fx = Owned(await Loaded());
        var gone = Path.Combine(fx.Root, "GoneMod");
        var disk = TreeSnapshot.Of(fx.Root);
        var held = Held();

        var created = await Create(Client, "Created.esp", gone);

        Assert.Equal(HttpStatusCode.NotFound, created.StatusCode);
        Assert.Equal("FolderGone", (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refusal").GetString());
        Assert.Equal(disk, TreeSnapshot.Of(fx.Root));
        Assert.Equal(held, Held());
    }

    [Fact]
    public async Task CreatingAPluginWithNoLoadOrderHeld_IsRefused_AndWritesNoFile()
    {
        var folder = Directory.CreateTempSubdirectory("medit-trace-create-homeless-").FullName;
        try
        {
            var created = await Create(Client, "Homeless.esp", folder);

            Assert.Equal(HttpStatusCode.ServiceUnavailable, created.StatusCode);
            Assert.Empty(Directory.EnumerateFileSystemEntries(folder));
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }
}
