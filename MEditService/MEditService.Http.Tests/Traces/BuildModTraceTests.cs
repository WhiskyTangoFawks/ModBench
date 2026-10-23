using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class BuildModTraceTests : HostedTests
{
    private const string Plugin = "Built.esp";
    private const string SecondPlugin = "AlsoBuilt.esp";
    private const string Origin = "ModBuildOutcome";
    private const string NonCompiledPlugin = "NonCompiledPlugin.esp";
    private const string NonCompiledPluginOrigin = "NonSourceMod";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-build-mod")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew("BuiltNpc"), origin: Origin)
        .WithPlugin(SecondPlugin, mod => mod.Npcs.AddNew("AlsoBuiltNpc"), origin: Origin)
        .WithPlugin(NonCompiledPlugin, mod => mod.Npcs.AddNew("NonCompiledPluginNpc"), origin: NonCompiledPluginOrigin)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    private string _builtFolder = string.Empty;

    private string StatCache => Path.Combine(_instance.Root, "stat-cache");

    private async Task LoadedWithOneModFolderAndCompiledPlugin()
    {
        _builtFolder = Path.GetDirectoryName(_instance.Plugins.Single(p => p.Name == Plugin).Path).Require();
        var second = _instance.Plugins.Single(p => p.Name == SecondPlugin);
        var movedTo = Path.Combine(_builtFolder, SecondPlugin);
        File.Move(second.Path, movedTo, overwrite: true);
        (await Client.PutLoadOrder(_instance, _instance.Plugins.Select(p => p == second ? p with { Path = movedTo } : p)))
            .EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
    }

    private static async Task<JsonElement> Answer(HttpResponseMessage response)
    {
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task BuildingAMod_CompilesEveryPluginOfItFromItsSource_NamesThePluginChangedOutsideModbench_AndReportsItsProgress()
    {
        await LoadedWithOneModFolderAndCompiledPlugin();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        var otherFormKey = await Client.FirstFormKey(SecondPlugin, Origin);
        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();
        (await Client.Edit(otherFormKey, SecondPlugin, Origin, "HeightMax", 0.5)).EnsureSuccessStatusCode();
        File.AppendAllText(Path.Combine(_builtFolder, Plugin), "changed outside Modbench");
        using var stream = await Client.NotificationStream();

        var answer = await Answer(await Client.Build([(Origin, _builtFolder)], StatCache, version: "1.2.3"));

        Assert.Empty(answer.GetProperty("refused").EnumerateArray());
        var built = Assert.Single(answer.GetProperty("applied").EnumerateArray());
        Assert.Equal(Origin, built.GetProperty("mod").GetString());
        Assert.Equal("1.2.3", new MEditService.ModFolderAdapter.ModFolderRepository(TimeProvider.System).ReadManifest(_builtFolder, Origin)?.Version);
        Assert.Empty(built.GetProperty("refused").EnumerateArray());
        Assert.Equal(
            [SecondPlugin, Plugin],
            built.GetProperty("compiled").EnumerateArray().Select(p => p.GetProperty("name").GetString()).Order());
        Assert.Equal([Plugin], built.GetProperty("overwritten").EnumerateArray().Select(p => p.GetString()));
        Assert.Equal(0.75, await HeightMaxOfTheWrittenBytes(Plugin, formKey), 3);
        Assert.Equal(0.5, await HeightMaxOfTheWrittenBytes(SecondPlugin, otherFormKey), 3);

        var progress = await stream.EventsUntil(
            "build-progress", e => e.GetProperty("modlistProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("modlistProgress").GetProperty("mod").GetString() == Origin);
    }

    [Fact]
    public async Task RestoringAModWhoseSubmoduleIsAbsent_HasGitCloneItAtThePin_AndBuildsIt()
    {
        await LoadedWithOneModFolderAndCompiledPlugin();
        var source = Client.SourceFolderSentFor(Origin);
        var remote = Path.Combine(_instance.Root, "remote");
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var copy = Path.Combine(remote, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(copy).Require());
            File.Copy(file, copy);
        }
        var pin = GitProbe.Run(Path.Combine(source, ".git"), source, "rev-parse", "HEAD").Trim();
        using var submodule = new PinnedSubmodule(_instance.Root, Origin);
        submodule.Pin(pin);
        var manifest = JsonSerializer.Serialize(new { package = new { submodule = Origin }, files = new[] { new { path = Plugin } } });
        File.WriteAllText(Path.Combine(_builtFolder, $"{Origin}.manifest.json"), manifest);

        var answer = await Answer(await Client.PostAsJsonAsync("/restore-from-manifest", new
        {
            mods = new[]
            {
                new
                {
                    name = Origin, folder = _builtFolder, metadataFiles = new[] { "meta.ini" },
                    submodule = new { folder = submodule.Folder, pin },
                },
            },
            statCache = StatCache,
            exclusionMark = ".mohidden",
        }));

        Assert.Empty(answer.GetProperty("refused").EnumerateArray());
        Assert.Equal(Origin, Assert.Single(answer.GetProperty("applied").EnumerateArray()).GetProperty("mod").GetString());
        Assert.Equal(pin, PinnedSubmodule.Git(submodule.Folder, "rev-parse", "HEAD").Trim());
    }

    [Fact]
    public async Task BuildingAModWhoseSourceHoldsNoBuildConfiguration_RefusesItByName_AndBuildsTheRest()
    {
        await LoadedWithOneModFolderAndCompiledPlugin();
        var nonCompiledPluginFolder = Path.GetDirectoryName(_instance.Plugins.Single(p => p.Name == NonCompiledPlugin).Path).Require();

        var answer = await Answer(await Client.Build([(NonCompiledPluginOrigin, nonCompiledPluginFolder), (Origin, _builtFolder)], StatCache));

        Assert.Equal([Origin], answer.GetProperty("applied").EnumerateArray().Select(m => m.GetProperty("mod").GetString()));
        var refused = Assert.Single(answer.GetProperty("refused").EnumerateArray());
        Assert.Equal(NonCompiledPluginOrigin, refused.GetProperty("item").GetString());
        Assert.Equal("SourceUnreadable", refused.GetProperty("refusal").GetString());
        Assert.EndsWith("holds no build configuration.", refused.GetProperty("message").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task BuildingAModWithAnArchiveToPack_PacksItAsTheRequestsVariantSays()
    {
        await LoadedWithOneModFolderAndCompiledPlugin();
        var source = Client.SourceFolderSentFor(Origin);
        Directory.CreateDirectory(Path.Combine(source, "assets", "meshes"));
        File.WriteAllText(Path.Combine(source, "assets", "meshes", "a.nif"), "mesh");
        File.WriteAllText(Path.Combine(source, "build.json"), $"{{\"output\": \"{Path.GetFileName(_builtFolder)}\", \"archives\": {{\"Main.ba2\": [\"meshes/a.nif\"]}}}}");
        var ba2 = new { ba2 = new { version = 1, compressed = true } };

        var answer = await Answer(await Client.Build([(Origin, _builtFolder)], StatCache, new { general = ba2, textures = ba2 }));

        Assert.Empty(Assert.Single(answer.GetProperty("applied").EnumerateArray()).GetProperty("archivesRefused").EnumerateArray());
        Assert.Equal("BTDX", System.Text.Encoding.ASCII.GetString(File.ReadAllBytes(Path.Combine(_builtFolder, "Main.ba2")), 0, 4));
        Assert.False(File.Exists(Path.Combine(_builtFolder, "meshes", "a.nif")));
    }

    public static TheoryData<string, string> NotARequestToBuild => new()
    {
        { "no mod", "{\"mods\": [], \"exclusionMark\": \".mohidden\"}" },
        { "no folder", "{\"mods\": [{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\"}], \"exclusionMark\": \".mohidden\"}" },
        { "no exclusion mark", "{\"mods\": [{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", \"folder\": \"f\"}], \"statCache\": \"c\"}" },
        { "no stat cache", "{\"mods\": [{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", \"folder\": \"f\"}], \"exclusionMark\": \".mohidden\"}" },
        {
            "a variant both a BA2 and a BSA",
            "{\"mods\": [{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", \"folder\": \"f\"}], \"exclusionMark\": \".mohidden\", \"statCache\": \"c\", " +
            "\"archives\": {\"general\": {\"ba2\": {\"version\": 1, \"compressed\": true}, \"bsa\": {\"version\": 105, \"archiveFlags\": 3, \"fileFlags\": 0}}, " +
            "\"textures\": {\"ba2\": {\"version\": 1, \"compressed\": true}}}}"
        },
    };

    [Theory]
    [MemberData(nameof(NotARequestToBuild))]
    public async Task ARequestThatDoesNotSayWhatToBuild_Is400(string lacking, string body)
    {
        await LoadedWithOneModFolderAndCompiledPlugin();

        using var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
        var response = await Client.PostAsync("/build", content);

        Assert.True(response.StatusCode == HttpStatusCode.BadRequest, lacking);
    }

    private async Task<double> HeightMaxOfTheWrittenBytes(string plugin, string formKey)
    {
        using var elsewhere = new PluginFixtureBuilder("trace-build-reader").BuildScattered();
        using var reader = new MEditHost();
        using var client = reader.CreateClient();
        var copied = Path.Combine(Directory.CreateDirectory(Path.Combine(elsewhere.Root, "ReadingMod")).FullName, plugin);
        File.Copy(Path.Combine(_builtFolder, plugin), copied);

        (await client.PutLoadOrder(
            elsewhere,
            [new LoadOrderEntry(plugin, copied, "ReadingMod", Line: 0, Enabled: true, Winning: true)]))
            .EnsureSuccessStatusCode();

        return (await client.Record(formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax")
            .GetProperty("value").GetDouble();
    }
}
