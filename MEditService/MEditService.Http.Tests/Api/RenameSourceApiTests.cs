using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class RenameSourceApiTests : HostedTests
{
    private const string Plugin = "Tracked.esp";
    private const string Origin = "TrackedMod";
    private const string Npc = "TrackedNpc";
    private const string UntrackedOrigin = "UntrackedMod";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("api-rename-source")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
        .WithPlugin("Other.esp", mod => mod.Npcs.AddNew("OtherNpc"), origin: UntrackedOrigin)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    private string ModFolder => OtherTool.ModFolderOf(_instance, Origin);

    private async Task Tracked()
    {
        (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
    }

    private Task<HttpResponseMessage> RenameSource(string name, string origin, string newName) =>
        Client.PostAsJsonAsync("/plugins/rename-source", new { origin, name, newName });

    private static async Task<string?> RefusalOf(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refusal").GetString();

    [Fact]
    public async Task RenamingATrackedPluginsSource_Is204_AndItsSourceTakesTheNewName()
    {
        await Tracked();

        var response = await RenameSource(Plugin, Origin, "Renamed.esp");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.False(Directory.Exists(PluginSourceRoot.In(ModFolder, Plugin)));
        Assert.Contains(
            Directory.EnumerateFiles(PluginSourceRoot.In(ModFolder, "Renamed.esp"), "*", SearchOption.AllDirectories),
            file => File.ReadAllText(file).Contains(Npc, StringComparison.Ordinal));
    }

    [Fact]
    public async Task RenamingToANameThatIsNoPluginFile_Is400()
    {
        await Tracked();

        var response = await RenameSource(Plugin, Origin, "Renamed.txt");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("NotAPluginFile", await RefusalOf(response));
    }

    [Fact]
    public async Task RenamingAPluginNotInTheLoadOrder_Is404()
    {
        await Tracked();

        var response = await RenameSource("NoSuch.esp", Origin, "Renamed.esp");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("PluginNotLoaded", await RefusalOf(response));
    }

    [Fact]
    public async Task RenamingAPluginWithNoPluginSource_Is409()
    {
        await Tracked();

        var response = await RenameSource("Other.esp", UntrackedOrigin, "Renamed.esp");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("NotTracked", await RefusalOf(response));
    }

    [Fact]
    public async Task RenamingASourceHoldingADocumentThatIsNoJson_Is422()
    {
        await Tracked();
        OtherTool.EditsASourceDocument(ModFolder, Plugin, Npc, "\"broken");

        var response = await RenameSource(Plugin, Origin, "Renamed.esp");

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal("UnreadableSource", await RefusalOf(response));
    }

    [Fact]
    public async Task RenamingWhenGitRefusesTheWrite_Is500()
    {
        await Tracked();
        File.WriteAllText(Path.Combine(ModFolder, ".git", "refs", "medit", "last-compile", "Renamed.esp.lock"), "");

        var response = await RenameSource(Plugin, Origin, "Renamed.esp");

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal("WriteFailed", await RefusalOf(response));
    }

    [Fact]
    public async Task RenamingWithNoLoadOrder_Is503()
    {
        var response = await RenameSource(Plugin, Origin, "Renamed.esp");

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    [Theory]
    [InlineData("", Origin)]
    [InlineData(Plugin, " ")]
    public async Task RenamingWithoutAPluginNameOrOrigin_Is400(string name, string origin)
    {
        await Tracked();

        var response = await RenameSource(name, origin, "Renamed.esp");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class RenameSourceWithoutGitApiTests : HostedTests
{
    private const string Plugin = "Tracked.esp";
    private const string Origin = "TrackedMod";

    [Fact]
    public async Task RenamingWithGitMissing_Is500_AndLeavesTheSourceWhereItWas()
    {
        using var fx = new PluginFixtureBuilder("api-rename-source-without-git")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("TrackedNpc"), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();

        HttpResponseMessage response;
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            response = await Client.PostAsJsonAsync("/plugins/rename-source", new { origin = Origin, name = Plugin, newName = "Renamed.esp" });
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal("GitUnavailable", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refusal").GetString());
        Assert.True(Directory.Exists(PluginSourceRoot.In(OtherTool.ModFolderOf(fx, Origin), Plugin)));
    }
}
