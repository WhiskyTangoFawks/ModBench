using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class VersionInGitTraceTests : HostedTests
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

        var response = await Client.InitSourceMod(Origin);

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var applied = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal(Origin, applied.GetProperty("mod").GetString());
        var plugin = Assert.Single(applied.GetProperty("plugins").EnumerateArray());
        Assert.Equal((Plugin, Origin), (plugin.GetProperty("name").GetString(), plugin.GetProperty("origin").GetString()));
        Assert.Empty(body.GetProperty("refused").EnumerateArray());

        var progress = await stream.EventsUntil(
            "init-source-mod-progress", e => e.TryGetProperty("initSourceModPhase", out var phase) && phase.GetString() == "Committing");
        Assert.Contains(progress, e => e.GetProperty("modlistProgress").GetProperty("mod").GetString() == Origin);

        var edit = await Client.Edit(await Client.FirstFormKey(Plugin, Origin), Plugin, Origin, "HeightMax", 0.75);
        edit.EnsureSuccessStatusCode();
        Assert.NotEmpty((await edit.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("documents").EnumerateArray());
    }

    [Fact]
    public async Task Init_CommitsTheAssetsAndTheBuildFileItIsHanded()
    {
        var modFolder = OtherTool.ModFolderOf(_instance, Origin);
        OtherTool.WritesTheFile(Path.Combine(modFolder, "meshes", "installed.nif"), "hello");
        OtherTool.WritesTheFile(Path.Combine(modFolder, "textures", "added.dds"), "added after install");
        await Loaded();
        var sourceFolder = Client.SourceFolderSentFor(Origin);

        var response = await Client.PostAsJsonAsync("/init-source-mod", new
        {
            mods = new[]
            {
                new { name = Origin, modFolder, commit = true, repository = new { sourceFolder, assets = new[] { "textures/added.dds" }, buildFile = "the build file" } },
            },
        });

        response.EnsureSuccessStatusCode();
        Assert.Empty((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refused").EnumerateArray());
        var committed = GitProbe.Run(Path.Combine(sourceFolder, ".git"), sourceFolder, "ls-tree", "-r", "--name-only", "HEAD")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Where(path => !path.StartsWith("plugin-source/", StringComparison.Ordinal));
        Assert.Equal([".gitignore", "build.json", "textures/added.dds"], committed);
        Assert.Equal("the build file", GitProbe.Run(Path.Combine(sourceFolder, ".git"), sourceFolder, "show", "HEAD:build.json"));
    }

    public static TheoryData<string, string> NotARequestToInit => new()
    {
        { "no mod", """{"mods": []}""" },
        { "a mod without a name", """{"mods": [{"name": "", "modFolder": "m", "commit": true, "repository": {"sourceFolder": "s", "buildFile": "{}"}}]}""" },
        { "a mod without a folder", """{"mods": [{"name": "InitializedMod", "commit": true, "repository": {"sourceFolder": "s", "buildFile": "{}"}}]}""" },
        { "a mod without commit", """{"mods": [{"name": "InitializedMod", "modFolder": "m", "repository": {"sourceFolder": "s", "buildFile": "{}"}}]}""" },
        { "a mod without a source folder", """{"mods": [{"name": "InitializedMod", "modFolder": "m", "commit": true, "repository": {"buildFile": "{}"}}]}""" },
        { "a mod without a build file", """{"mods": [{"name": "InitializedMod", "modFolder": "m", "commit": true, "repository": {"sourceFolder": "s"}}]}""" },
        { "an asset outside the mod folder", """{"mods": [{"name": "InitializedMod", "modFolder": "m", "commit": true, "repository": {"sourceFolder": "s", "assets": ["../a.dds"], "buildFile": "{}"}}]}""" },
        { "a manifest without its file name", """{"mods": [{"name": "InitializedMod", "modFolder": "m", "commit": true, "repository": {"sourceFolder": "s", "buildFile": "{}", "manifest": "{}"}}]}""" },
        { "a manifest without its text", """{"mods": [{"name": "InitializedMod", "modFolder": "m", "commit": true, "repository": {"sourceFolder": "s", "buildFile": "{}", "manifestFile": "M.manifest.json"}}]}""" },
        { "a manifest file name that is a path", """{"mods": [{"name": "InitializedMod", "modFolder": "m", "commit": true, "repository": {"sourceFolder": "s", "buildFile": "{}", "manifestFile": "../M.manifest.json", "manifest": "{}"}}]}""" },
    };

    [Theory]
    [MemberData(nameof(NotARequestToInit))]
    public async Task ARequestThatDoesNotSayWhatToInit_Is400(string lacking, string body)
    {
        await Loaded();

        var response = await Client.PostJson("/init-source-mod", body);

        Assert.Equal((lacking, HttpStatusCode.BadRequest), (lacking, response.StatusCode));
    }

    [Theory]
    [InlineData("\"manifest\": \"{}\"", "ManifestFile is missing")]
    [InlineData("\"manifestFile\": \"M.manifest.json\"", "Manifest is missing")]
    [InlineData("\"manifestFile\": \"a/M.manifest.json\", \"manifest\": \"{}\"", "bare file name")]
    public async Task ARequestWithHalfAManifest_IsRefused_NamingWhatIsWrong(string manifestMembers, string named)
    {
        await Loaded();

        var response = await Client.PostJson(
            "/init-source-mod",
            $$$"""{"mods": [{"name": "InitializedMod", "modFolder": "m", "commit": true, "repository": {"sourceFolder": "s", "buildFile": "{}", {{{manifestMembers}}}}}]}""");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains(named, await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AfterInit_TheNextSnapshotReportsThePluginCompiledPlugin()
    {
        await Loaded();
        Assert.False((await Client.Plugin(Plugin)).GetProperty("isCompiledPlugin").GetBoolean());

        (await Client.InitSourceMod(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(_instance);

        await Client.PluginReportsCompiledPlugin(Plugin);
    }
}
