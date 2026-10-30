using System.Net;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.Http.Tests.TestSupport.Wire;

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

        var answer = await Answer(await Client.Build([(Origin, _builtFolder)]));

        Assert.Empty(answer.GetProperty("refused").EnumerateArray());
        var built = Assert.Single(answer.GetProperty("applied").EnumerateArray());
        Assert.Equal(Origin, built.GetProperty("mod").GetString());
        Assert.Empty(built.GetProperty("refused").EnumerateArray());
        Assert.Equal(
            [(SecondPlugin, true), (Plugin, true)],
            built.GetProperty("made").EnumerateArray().Select(file => (file.GetProperty("path").GetString(), file.GetProperty("vouchedFor").GetBoolean())).Order());
        Assert.Equal(
            [SecondPlugin, Plugin],
            built.GetProperty("compiled").EnumerateArray().Select(p => p.GetProperty("name").GetString()).Order());
        Assert.Equal([Plugin], built.GetProperty("overwritten").EnumerateArray().Select(p => p.GetString()));
        Assert.Equal(0.75, await HeightMaxInTheBytesAt(Path.Combine(_builtFolder, Plugin), formKey), 3);
        Assert.Equal(0.5, await HeightMaxInTheBytesAt(Path.Combine(_builtFolder, SecondPlugin), otherFormKey), 3);

        var progress = await stream.EventsUntil(
            "build-progress", e => e.GetProperty("modlistProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("modlistProgress").GetProperty("mod").GetString() == Origin);
    }

    [Fact]
    public async Task BuildingAModWhoseArchiveTakesNoAssetOfItsSource_RefusesItByName_AndBuildsTheRest()
    {
        await LoadedWithOneModFolderAndCompiledPlugin();
        (await Client.DecompileAndCommit(NonCompiledPluginOrigin)).EnsureSuccessStatusCode();
        var otherFolder = Path.GetDirectoryName(_instance.Plugins.Single(p => p.Name == NonCompiledPlugin).Path).Require();

        var answer = await Answer(await Client.Build(
            [(NonCompiledPluginOrigin, otherFolder), (Origin, _builtFolder)], archives: [new { path = "Main.ba2", files = new[] { "meshes/a.nif" } }]));

        Assert.Empty(answer.GetProperty("applied").EnumerateArray());
        Assert.Equal(
            [("ArchiveFileNotAnAsset", NonCompiledPluginOrigin), ("ArchiveFileNotAnAsset", Origin)],
            answer.GetProperty("refused").EnumerateArray().Select(m => (m.GetProperty("refusal").GetString(), m.GetProperty("item").GetString())));
    }

    [Fact]
    public async Task BuildingAModWithAnArchiveToPack_PacksItAsTheRequestsVariantSays()
    {
        await LoadedWithOneModFolderAndCompiledPlugin();
        var source = Client.SourceFolderSentFor(Origin);
        Directory.CreateDirectory(Path.Combine(source, "assets", "meshes"));
        File.WriteAllText(Path.Combine(source, "assets", "meshes", "a.nif"), "mesh");
        var ba2 = new { ba2 = new { version = 1, compressed = true } };

        var answer = await Answer(await Client.Build(
            [(Origin, _builtFolder)], new { general = ba2, textures = ba2 }, [new { path = "Main.ba2", files = new[] { "meshes/a.nif" } }]));

        Assert.Empty(Assert.Single(answer.GetProperty("applied").EnumerateArray()).GetProperty("archivesRefused").EnumerateArray());
        Assert.Equal("BTDX", System.Text.Encoding.ASCII.GetString(File.ReadAllBytes(Path.Combine(_builtFolder, "Main.ba2")), 0, 4));
        Assert.False(File.Exists(Path.Combine(_builtFolder, "meshes", "a.nif")));
    }

    public static TheoryData<string, string> NotARequestToBuild => new()
    {
        { "no mod", "{\"mods\": [], \"exclusionMark\": \".mohidden\"}" },
        { "no folder", "{\"mods\": [{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\"}], \"exclusionMark\": \".mohidden\"}" },
        { "no exclusion mark", "{\"mods\": [{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", \"folder\": \"f\"}]}" },
        { "a taken path outside the folder", "{\"mods\": [{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", \"folder\": \"f\", \"taken\": [\"../a.nif\"]}], \"exclusionMark\": \".mohidden\"}" },
        { "an archive's file outside the folder", "{\"mods\": [{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", \"folder\": \"f\", \"archives\": [{\"path\": \"Main.ba2\", \"files\": [\"/a.nif\"]}]}], \"exclusionMark\": \".mohidden\"}" },
        {
            "a variant both a BA2 and a BSA",
            "{\"mods\": [{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", \"folder\": \"f\"}], \"exclusionMark\": \".mohidden\", " +
            "\"archives\": {\"general\": {\"ba2\": {\"version\": 1, \"compressed\": true}, \"bsa\": {\"version\": 105, \"archiveFlags\": 3, \"fileFlags\": 0}}, " +
            "\"textures\": {\"ba2\": {\"version\": 1, \"compressed\": true}}}}"
        },
    };

    [Theory]
    [MemberData(nameof(NotARequestToBuild))]
    public async Task ARequestThatDoesNotSayWhatToBuild_Is400(string lacking, string body)
    {
        await LoadedWithOneModFolderAndCompiledPlugin();

        var response = await Client.PostJson("/build", body);

        Assert.Equal((lacking, HttpStatusCode.BadRequest), (lacking, response.StatusCode));
    }
}
