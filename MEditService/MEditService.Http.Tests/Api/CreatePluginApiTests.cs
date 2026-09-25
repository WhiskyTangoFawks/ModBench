using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

/// <summary>The create gesture writes the file and nothing else: the load order it answers beside is
/// the one it found, and the plugin reaches a reader only once a load order names it.</summary>
[Collection(WebHostCollection.Name)]
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

    // A record gesture resolves its target from the held load order alone, so a refused one is the
    // plugin not being registered there.
    private Task<HttpResponseMessage> CreateARecordIn(string plugin, string origin = Origin) =>
        Client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString(plugin)}/records",
            new { origin, recordType = "npc_", editorId = "MintedNpc", formKey = (string?)null });

    private long HeldVersion() => Services.GetRequiredService<LoadOrderHolder>().Version;

    [Fact]
    public async Task CreatingAPluginInAMod_AnswersWithThePluginItWrote_AndRegistersNothing()
    {
        var fx = Owned(await Loaded());
        var modFolder = NewModFolder(fx, "mod-minted");

        var created = await Created("Minted.esp", modFolder, "MintedMod");

        Assert.Equal("Minted.esp", created.GetProperty("name").GetString());
        Assert.Equal("MintedMod", created.GetProperty("origin").GetString());
        Assert.Equal(Path.Combine(modFolder, "Minted.esp"), created.GetProperty("path").GetString());
        Assert.False((await CreateARecordIn("Minted.esp", "MintedMod")).IsSuccessStatusCode);
    }

    // The plugin reaches the Index through the load order Mod Management puts once plugin sync gave
    // it a line, never through the create itself.
    [Fact]
    public async Task CreatingAPlugin_LeavesThePluginsReadAsItWas_UntilALoadOrderNamesIt()
    {
        var fx = Owned(await Loaded());
        var modFolder = NewModFolder(fx, "mod-listed");
        var before = (await Client.Plugins()).Select(p => p.GetProperty("name").GetString()).ToList();

        var created = await Created("Listed.esp", modFolder, "ListedMod");

        Assert.Equal(before, (await Client.Plugins()).Select(p => p.GetProperty("name").GetString()));
        var named = fx.Plugins.Append(new LoadOrderEntry(
            "Listed.esp", created.GetProperty("path").GetString().Require(), "ListedMod",
            fx.Plugins.Count, Enabled: false, Winning: true));
        (await Client.PutLoadOrder(fx, named)).EnsureSuccessStatusCode();
        Assert.Contains(await Client.Plugins(), p => p.GetProperty("name").GetString() == "Listed.esp");
    }

    // The slot is plugin sync's to give, at the end of plugins.txt: the create answers none, and the
    // held load order keeps the version it had.
    [Fact]
    public async Task CreatingAPlugin_AnswersNoSlotOrVersion_AndLeavesTheHeldLoadOrderVersion()
    {
        var fx = Owned(await Loaded());
        var version = HeldVersion();

        var created = await Created("Slotted.esp", NewModFolder(fx, "mod-slotted"), "SlottedMod");

        Assert.False(created.TryGetProperty("slot", out _));
        Assert.False(created.TryGetProperty("version", out _));
        Assert.Equal(version, HeldVersion());
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
    public async Task CreatingAPluginWithAFilenameTheWriterRefuses_Is400_AndWritesNothing()
    {
        var fx = Owned(await Loaded());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);

        var created = await Create("Bad|Name.esp", modFolder);

        Assert.Equal(HttpStatusCode.BadRequest, created.StatusCode);
        Assert.False(File.Exists(Path.Combine(modFolder, "Bad|Name.esp")));
    }

    [Fact]
    public async Task CreatingTheSameNameTwice_Is409_AndLeavesTheFirstFileAsItWas()
    {
        var fx = Owned(await Loaded());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var path = (await Created("Twice.esp", modFolder)).GetProperty("path").GetString().Require();
        var first = await File.ReadAllBytesAsync(path);

        var second = await Create("Twice.esp", modFolder);

        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        Assert.Equal("FileExists", (await second.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refusal").GetString());
        Assert.Equal(first, await File.ReadAllBytesAsync(path));
    }

    // Tracking is the user's own gesture (ADR-0007 invariant 2): the new plugin is untracked, and
    // so is the mod it landed in.
    [Fact]
    public async Task CreatingIntoAnUntrackedMod_TracksNothing()
    {
        var fx = Owned(await Loaded());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);

        await Created("Untracked.esp", modFolder);

        Assert.False(Directory.Exists(Path.Combine(modFolder, ".git")));
        Assert.False((await Client.Plugin(Held)).GetProperty("isTracked").GetBoolean());
    }

    // The rival is the retired create, which parked the new binary as a compile of its own and so
    // moved a ref in the mod's repository.
    [Fact]
    public async Task CreatingIntoATrackedMod_LeavesItsRepositoryAsItWas()
    {
        var fx = Owned(await Loaded());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        (await Client.Track(Held, Origin)).EnsureSuccessStatusCode();
        var repository = TreeSnapshot.Of(Path.Combine(modFolder, ".git"));

        await Created("Second.esp", modFolder);

        Assert.Equal(repository, TreeSnapshot.Of(Path.Combine(modFolder, ".git")));
    }

    // Nothing the create writes stands between a tracked mod's own plugin and its source: a hand
    // edit to that source still reaches the next query.
    [Fact]
    public async Task AfterCreateIntoATrackedMod_AHandEditToItsSource_ReachesTheNextQuery()
    {
        var fx = Owned(await Loaded());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        (await Client.Track(Held, Origin)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(Held);
        await Created("Minted.esp", modFolder);
        var before = await Client.Sequence();

        OtherTool.EditsASourceDocument(modFolder, Held, Npc, "RenamedByHand");

        await Client.SequenceReaches(before + 1);
        Assert.Equal("RenamedByHand", (await Client.Record(formKey)).GetProperty("editorId").GetString());
    }
}
