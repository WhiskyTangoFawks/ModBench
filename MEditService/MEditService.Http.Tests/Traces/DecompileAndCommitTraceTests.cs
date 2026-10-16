using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class DecompileAndCommitTraceTests : HostedTests
{
    private const string Plugin = "Initialized.esp";
    private const string Origin = "InitializedMod";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-init-mod")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew("InitializedNpc"), origin: Origin)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    private async Task Loaded() => (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

    [Fact]
    public async Task InitOfALoadedPlugin_AnswersItApplied_ReportsItsProgress_AndLeavesItEditable()
    {
        await Loaded();
        using var stream = await Client.NotificationStream();

        var response = await Client.Init(Origin);

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var applied = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal(Origin, applied.GetProperty("mod").GetString());
        var plugin = Assert.Single(applied.GetProperty("plugins").EnumerateArray());
        Assert.Equal((Plugin, Origin), (plugin.GetProperty("name").GetString(), plugin.GetProperty("origin").GetString()));
        Assert.Empty(body.GetProperty("refused").EnumerateArray());

        var progress = await stream.EventsUntil(
            "init-progress", e => e.GetProperty("initProgress").GetProperty("phase").GetString() == "Idle");
        Assert.Contains(progress, e => e.GetProperty("initProgress").GetProperty("mod").GetString() == Origin);

        var edit = await Client.Edit(await Client.FirstFormKey(Plugin, Origin), Plugin, Origin, "HeightMax", 0.75);
        edit.EnsureSuccessStatusCode();
        Assert.NotEmpty((await edit.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("documents").EnumerateArray());
    }

    [Fact]
    public async Task InitOfAModInstalledFromADownloadedFile_AsModbenchSendsIt_CommitsAsAssetsOnlyTheFilesItDoesNotYield()
    {
        const string HashOfHello = "o22fiH2CxyY=";
        var modFolder = OtherTool.ModFolderOf(_instance, Origin);
        OtherTool.WritesTheFile(Path.Combine(modFolder, "textures", "yielded.dds"), "hello");
        OtherTool.WritesTheFile(Path.Combine(modFolder, "textures", "added.dds"), "added after install");
        await Loaded();
        var sourceFolder = Client.SourceFolderSentFor(Origin);

        var response = await Client.PostAsJsonAsync("/init", new
        {
            mods = new[]
            {
                new
                {
                    name = Origin,
                    sourceFolder,
                    installationFiles = new[]
                    {
                        new
                        {
                            path = Path.Combine(_instance.Root, "downloads", "Mod.7z"), size = 28, hash = "yMPjZVarjmw=",
                            entries = new[] { new { path = "textures/yielded.dds", hash = HashOfHello } },
                        },
                    },
                    metadataFiles = new[] { "meta.ini" },
                },
            },
        });

        response.EnsureSuccessStatusCode();
        Assert.Empty((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refused").EnumerateArray());
        var committed = GitProbe.Run(Path.Combine(sourceFolder, ".git"), sourceFolder, "ls-tree", "-r", "--name-only", "HEAD")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Where(path => path.StartsWith("assets/", StringComparison.Ordinal));
        Assert.Equal(["assets/textures/added.dds"], committed);
    }

    [Fact]
    public async Task InitOfNoMod_Is400()
    {
        await Loaded();

        var response = await Client.Init([]);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task InitOfAModWithoutAName_Is400()
    {
        await Loaded();

        var response = await Client.Init(string.Empty);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task InitOfAModWithoutASourceFolder_Is400()
    {
        await Loaded();

        var response = await Client.PostAsJsonAsync("/init", new
        {
            mods = new[] { new { name = Origin, installationFiles = Array.Empty<object>(), metadataFiles = Array.Empty<string>() } },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task InitOfAModWithAnInstallationFileThatHasNoHash_Is400()
    {
        await Loaded();

        var response = await Client.PostAsJsonAsync("/init", new
        {
            mods = new[]
            {
                new
                {
                    name = Origin,
                    installationFiles = new[] { new { path = "/downloads/Mod.7z", size = 1, entries = Array.Empty<object>() } },
                    metadataFiles = new[] { "meta.ini" },
                },
            },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task InitOfAModNamingABlankFileOfTheModManagers_Is400()
    {
        await Loaded();

        var response = await Client.PostAsJsonAsync("/init", new
        {
            mods = new[] { new { name = Origin, installationFiles = Array.Empty<object>(), metadataFiles = new[] { " " } } },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task InitOfAModThatProvidesNoPlugin_RefusesThatMod_AndLandsTheOthers()
    {
        await Loaded();

        var response = await Client.Init([Origin, "NoSuchMod"]);

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal([Origin], body.GetProperty("applied").EnumerateArray().Select(m => m.GetProperty("mod").GetString()));
        var refused = Assert.Single(body.GetProperty("refused").EnumerateArray());
        Assert.Equal(("NoSuchMod", "ModProvidesNoPlugin"), (refused.GetProperty("item").GetString(), refused.GetProperty("refusal").GetString()));
        Assert.Contains("NoSuchMod", refused.GetProperty("message").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AfterInit_TheNextSnapshotReportsThePluginCompiledPlugin()
    {
        await Loaded();
        Assert.False((await Client.Plugin(Plugin)).GetProperty("isCompiledPlugin").GetBoolean());

        (await Client.Init(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(_instance);

        await Client.PluginReportsCompiledPlugin(Plugin);
    }
}
