using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class CreatePluginApiTests : HostedTests
{
    private const string Held = "Held.esp";
    private const string Origin = "CreatedIntoMod";
    private const string Npc = "HeldNpc";

    private static ScatteredFixtureData OneMod() =>
        new PluginFixtureBuilder("api-create-plugin")
            .WithPlugin(Held, mod => mod.Npcs.AddNew(Npc), origin: Origin)
            .BuildScattered();

    private async Task<ScatteredFixtureData> Loaded()
    {
        var fx = OneMod();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return fx;
    }

    private Task<HttpResponseMessage> Create(string name, string folder, string origin = Origin) =>
        Client.PostAsJsonAsync("/plugins/create", new { origin, name, folder });

    private async Task<JsonElement> Created(string name, string folder, string origin = Origin)
    {
        var created = await Create(name, folder, origin);
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        return await created.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static string NewModFolder(ScatteredFixtureData fx, string name) =>
        Directory.CreateDirectory(Path.Combine(fx.Root, name)).FullName;

    private Task<HttpResponseMessage> CreateARecordIn(string plugin, string origin = Origin) =>
        Client.CreateRecord(plugin, origin, "npc_");

    [Fact]
    public async Task CreatingAPluginInAMod_AnswersWithThePluginItWrote_AndRegistersNothing()
    {
        var fx = Owned(await Loaded());
        var modFolder = NewModFolder(fx, "mod-minted");

        var created = await Created("Minted.esp", modFolder, "MintedMod");

        Assert.Equal("Minted.esp", created.GetProperty("name").GetString());
        Assert.Equal("MintedMod", created.GetProperty("origin").GetString());
        Assert.True(File.Exists(Path.Combine(modFolder, "Minted.esp")));
        Assert.False((await CreateARecordIn("Minted.esp", "MintedMod")).IsSuccessStatusCode);
    }

    private Task<HttpResponseMessage> PutWithPlaces(ScatteredFixtureData fx, IEnumerable<LoadOrderEntry> plugins, params object[] places) =>
        Client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(fx.DataFolder, fx.InstanceRoot, plugins, places: places));

    private Task<HttpResponseMessage> CreateInMod(string origin, string name) =>
        Client.PostAsJsonAsync("/plugins/create-in-mod", new { origin, name });

    [Fact]
    public async Task CreatingAPluginInAPlaceTheSnapshotNamesWithNoPlugin_WritesItInThatPlacesFolder()
    {
        var fx = Owned(OneMod());
        var emptyFolder = NewModFolder(fx, "mod-empty");
        (await PutWithPlaces(fx, fx.Plugins, new { name = "EmptyMod", folder = emptyFolder })).EnsureSuccessStatusCode();

        var created = await CreateInMod("EmptyMod", "Patch.esp");

        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        Assert.True(File.Exists(Path.Combine(emptyFolder, "Patch.esp")));
    }

    [Fact]
    public async Task CreatingAPluginInASourceModPlaceWithNoPlugin_LandsItsSourceInTheSourceFolderTheSnapshotNamed()
    {
        var fx = Owned(OneMod());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(plugin => plugin.Origin == Origin).Path) ?? throw new InvalidOperationException("A mod plugin has a folder.");
        File.Delete(Path.Combine(modFolder, Held));
        (await PutWithPlaces(
            fx, fx.Plugins.Where(plugin => plugin.Origin != Origin), new { name = Origin, folder = modFolder, sourceFolder = modFolder })).EnsureSuccessStatusCode();

        var created = await CreateInMod(Origin, "Patch.esp");

        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        Assert.True(Directory.Exists(Path.Combine(modFolder, "plugin-source", "Patch.esp")));
    }

    [Fact]
    public async Task CreatingAPlugin_LeavesThePluginsReadAsItWas_UntilALoadOrderNamesIt()
    {
        var fx = Owned(await Loaded());
        var modFolder = NewModFolder(fx, "mod-listed");
        var before = (await Client.Plugins()).Select(p => p.GetProperty("name").GetString()).ToList();

        var created = await Created("Listed.esp", modFolder, "ListedMod");

        Assert.Equal(before, (await Client.Plugins()).Select(p => p.GetProperty("name").GetString()));
        var named = fx.Plugins.Append(new LoadOrderEntry(
            "Listed.esp", Path.Combine(modFolder, "Listed.esp"), "ListedMod",
            fx.Plugins.Count, Enabled: false, Winning: true));
        (await Client.PutLoadOrder(fx, named)).EnsureSuccessStatusCode();
        Assert.Contains(await Client.Plugins(), p => p.GetProperty("name").GetString() == "Listed.esp");
    }

    [Fact]
    public async Task CreatingAPluginWithAnInvalidExtension_Is400_AndWritesNothing()
    {
        var fx = Owned(await Loaded());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);

        var created = await Create("Mod.txt", modFolder);

        Assert.Equal(HttpStatusCode.BadRequest, created.StatusCode);
        var problem = await created.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains("extension", problem.GetProperty("detail").GetString().Require(), StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(modFolder, "Mod.txt")));
    }

    [Theory]
    [InlineData("", "SomeMod", "folder")]
    [InlineData("   ", "SomeMod", "folder")]
    [InlineData("New.esp", "   ", "folder")]
    [InlineData("New.esp", "SomeMod", "   ")]
    public async Task CreatingAPluginWithAnEmptyArgument_Is400(string name, string origin, string folder)
    {
        var fx = Owned(await Loaded());

        var created = await Create(name, folder == "folder" ? OtherTool.ModFolderOf(fx, Origin) : folder, origin);

        Assert.Equal(HttpStatusCode.BadRequest, created.StatusCode);
    }

    [Fact]
    public async Task CreatingAPluginWithoutAFolder_Is400()
    {
        Owned(await Loaded());

        var created = await Client.PostAsJsonAsync("/plugins/create", new { origin = Origin, name = "NoPath.esp" });

        Assert.Equal(HttpStatusCode.BadRequest, created.StatusCode);
    }

    [Fact]
    public async Task ARefusedCreate_IsLoggedOnce_NamingThePluginAndWhy()
    {
        var fx = Owned(await Loaded());
        var modFolder = NewModFolder(fx, "mod-taken");
        await Created("Taken.esp", modFolder, "TakenMod");

        await Create("Taken.esp", modFolder, "TakenMod");

        var logged = Assert.Single(Logged, entry => entry.Message.StartsWith("Refused Create plugin", StringComparison.Ordinal));
        Assert.Equal(LogLevel.Warning, logged.Level);
        Assert.Contains("Taken.esp", logged.Message, StringComparison.Ordinal);
        Assert.Contains("FileExists", logged.Message, StringComparison.Ordinal);
    }
}
