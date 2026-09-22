using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

/// <summary>The create gesture, which no trace draws: the endpoint is the load order's second
/// writer, so what it answers and what the next reader sees are one thing.</summary>
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

    private Task<HttpResponseMessage> Create(string name, string path, string origin = Origin) =>
        Client.PostAsJsonAsync("/plugins/create", new { name, path, origin });

    private async Task<JsonElement> CreateAndAwait(string name, string path, string origin = Origin)
    {
        var created = await Create(name, path, origin);
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var body = await created.Content.ReadFromJsonAsync<JsonElement>();
        await Client.AwaitTerminalLoadOrderStatus(body.GetProperty("version").GetInt64(), TimeSpan.FromSeconds(20));
        return body;
    }

    // A record gesture resolves its target from the kernel alone, so an applied one is the copy
    // being registered and its file being there.
    private Task<HttpResponseMessage> CreateARecordIn(string plugin, string origin = Origin) =>
        Client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString(plugin)}/records",
            new { origin, recordType = "npc_", editorId = "MintedNpc", formKey = (string?)null });

    [Fact]
    public async Task CreatingAPluginInAModOfItsOwn_AnswersWithTheCopyItRegistered_AndItIsWritableAtOnce()
    {
        var fx = Owned(await Loaded());
        var modFolder = Path.Combine(fx.Root, "mod-minted");

        var created = await CreateAndAwait("Minted.esp", modFolder, "MintedMod");

        Assert.Equal("Minted.esp", created.GetProperty("name").GetString());
        Assert.Equal("MintedMod", created.GetProperty("origin").GetString());
        Assert.Equal(Path.Combine(modFolder, "Minted.esp"), created.GetProperty("path").GetString());
        (await CreateARecordIn("Minted.esp", "MintedMod")).EnsureSuccessStatusCode();
    }

    // The copy reaches the Index through the create's own snapshot change, so the file must be
    // there when that change lands: a copy the reconcile cannot open is not a row.
    [Fact]
    public async Task CreatingAPlugin_ListsItOnTheNextPluginsRead()
    {
        var fx = Owned(await Loaded());

        await CreateAndAwait("Listed.esp", Path.Combine(fx.Root, "mod-listed"), "ListedMod");

        Assert.Contains(await Client.Plugins(), p => p.GetProperty("name").GetString() == "Listed.esp");
    }

    // One past the highest slot the value carries; a reused one would give two participants a single
    // index.
    [Fact]
    public async Task CreatingAPlugin_TakesTheSlotPastTheHighestRegisteredOne()
    {
        var fx = Owned(await Loaded());
        var highest = (await Client.Plugins())
            .Max(p => p.GetProperty("loadOrderIndex").ValueKind == JsonValueKind.Null
                ? 0
                : p.GetProperty("loadOrderIndex").GetInt32());

        var created = await CreateAndAwait("Slotted.esp", Path.Combine(fx.Root, "mod-slotted"), "SlottedMod");

        Assert.Equal(highest + 1, created.GetProperty("slot").GetInt32());
    }

    [Fact]
    public async Task CreatingAPluginWithNoLoadOrderHeld_Is503()
    {
        using var app = new MEditHost();
        using var client = app.CreateClient();

        var created = await client.PostAsJsonAsync(
            "/plugins/create",
            new { name = "Homeless.esp", path = Path.Combine(Path.GetTempPath(), "nowhere"), origin = "NoMod" });

        Assert.Equal(HttpStatusCode.ServiceUnavailable, created.StatusCode);
    }

    [Fact]
    public async Task CreatingAPluginWithAnInvalidExtension_Is400_AndRegistersNothing()
    {
        var fx = Owned(await Loaded());

        var created = await Create("Mod.txt", OtherTool.ModFolderOf(fx, Origin));

        Assert.Equal(HttpStatusCode.BadRequest, created.StatusCode);
        var problem = await created.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains("extension", problem.GetProperty("detail").GetString().Require(), StringComparison.Ordinal);
        Assert.False((await CreateARecordIn("Mod.txt")).IsSuccessStatusCode);
    }

    [Theory]
    [InlineData("", "SomeMod")]
    [InlineData("   ", "SomeMod")]
    [InlineData("New.esp", "   ")]
    public async Task CreatingAPluginWithAnEmptyArgument_Is400(string name, string origin)
    {
        var fx = Owned(await Loaded());

        var created = await Create(name, OtherTool.ModFolderOf(fx, Origin), origin);

        Assert.Equal(HttpStatusCode.BadRequest, created.StatusCode);
    }

    [Fact]
    public async Task CreatingAPluginWithoutADestination_Is400()
    {
        Owned(await Loaded());

        var created = await Client.PostAsJsonAsync("/plugins/create", new { name = "NoPath.esp" });

        Assert.Equal(HttpStatusCode.BadRequest, created.StatusCode);
    }

    // The registration precedes the file, so a create that cannot write its file leaves a copy the
    // load order should never have carried: the endpoint takes it back.
    [Fact]
    public async Task CreatingAPluginOverAFileAlreadyThere_Is409_AndRegistersNothing()
    {
        var fx = Owned(await Loaded());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        OtherTool.WritesTheFile(Path.Combine(modFolder, "Occupied.esp"), "not a plugin");

        var created = await Create("Occupied.esp", modFolder);

        Assert.Equal(HttpStatusCode.Conflict, created.StatusCode);
        Assert.False((await CreateARecordIn("Occupied.esp")).IsSuccessStatusCode);
    }

    [Fact]
    public async Task CreatingAPluginWithAFilenameTheWriterRefuses_Is400_AndRegistersNothing()
    {
        var fx = Owned(await Loaded());

        var created = await Create("Bad|Name.esp", OtherTool.ModFolderOf(fx, Origin));

        Assert.Equal(HttpStatusCode.BadRequest, created.StatusCode);
        Assert.False((await CreateARecordIn("Bad|Name.esp")).IsSuccessStatusCode);
    }

    [Fact]
    public async Task CreatingTheSameNameTwice_Is409_AndLeavesTheFirstRegistration()
    {
        var fx = Owned(await Loaded());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var first = await CreateAndAwait("Twice.esp", modFolder);

        var second = await Create("Twice.esp", modFolder);

        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        Assert.NotEqual(0, first.GetProperty("slot").GetInt32());
        (await CreateARecordIn("Twice.esp")).EnsureSuccessStatusCode();
    }

    // Creating into an untracked destination Tracks it inside the same gesture: a created plugin is
    // editable at once, and editing requires tracking.
    [Fact]
    public async Task CreatingIntoAnUntrackedDestination_LeavesThePluginEditable()
    {
        var fx = Owned(await Loaded());
        await CreateAndAwait("Editable.esp", OtherTool.ModFolderOf(fx, Origin));

        var record = await CreateARecordIn("Editable.esp");

        record.EnsureSuccessStatusCode();
        Assert.True((await record.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("applied").GetBoolean());
    }

    // The rival is Track's own refusal to re-track: a naive "always Track on create" would refuse the
    // second plugin instead of reusing the repository the first one made.
    [Fact]
    public async Task CreatingASecondPluginIntoTheSameDestination_Succeeds_AndReusesTheRepository()
    {
        var fx = Owned(await Loaded());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        await CreateAndAwait("First.esp", modFolder);
        var record = await CreateARecordIn("First.esp");
        record.EnsureSuccessStatusCode();
        var formKey = (await record.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("formKey").GetString().Require();

        var second = await Create("Second.esp", modFolder);

        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        // Tracking the destination again would write its tree from the binaries, losing a record only
        // the source tree holds; this edit lands, so the first create's repository was reused.
        (await Client.Edit(formKey, "First.esp", Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();
    }

    // The destination is Tracked inside the create gesture, so its watch is armed there too: the
    // mod's own copy answers from source with no load order put after the create.
    [Fact]
    public async Task AfterCreate_AHandEditToTheDestinationsSource_ReachesTheNextQuery()
    {
        var fx = Owned(await Loaded());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var formKey = await Client.FirstFormKey(Held);
        await CreateAndAwait("Minted.esp", modFolder);
        var before = await Client.Sequence();

        OtherTool.EditsASourceDocument(modFolder, Held, Npc, "RenamedByHand");

        await Client.SequenceReaches(before + 1);
        Assert.Equal("RenamedByHand", (await Client.Record(formKey)).GetProperty("editorId").GetString());
    }
}
