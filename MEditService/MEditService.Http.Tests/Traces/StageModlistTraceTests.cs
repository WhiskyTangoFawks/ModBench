using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Traces;

public sealed class StageModlistTraceTests : HostedTests
{
    private const string Mod = "StagedMod";
    private const string HashOfKept = "gO3vE0ddOto=";
    private const string HashOfOriginal = "wQsys923yLo=";
    private const string HashOfVanilla = "/Qk9lLVYbZs=";

    private readonly ScratchDirectory _instance = new("trace-stage-modlist-");

    protected override void DisposeFixtures() => _instance.Dispose();

    private string ModFolder => Path.Combine(_instance, "mods", Mod);

    private string Downloads => Path.Combine(_instance, "downloads");

    private void ModInstalledFromADownload(string editedText)
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "kept.txt"), "kept");
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), editedText);
        File.WriteAllText(Path.Combine(ModFolder, "Game.esm"), "vanilla");
        Directory.CreateDirectory(Downloads);
        File.WriteAllText(Path.Combine(Downloads, "Mod.zip"), "archive");
    }

    private (JsonObject Whole, JsonObject InstallationFile, JsonObject GameFile) Request(string downloadName)
    {
        var installationFile = new JsonObject
        {
            ["path"] = Path.Combine(Downloads, downloadName),
            ["source"] = "nexus:1:2",
            ["size"] = 7,
            ["hash"] = "WHOLE",
            ["entries"] = new JsonArray(
                new JsonObject { ["path"] = "kept.txt", ["hash"] = HashOfKept },
                new JsonObject { ["path"] = "edited.txt", ["hash"] = HashOfOriginal }),
        };
        var gameFile = new JsonObject { ["path"] = "Game.esm", ["size"] = 7, ["hash"] = HashOfVanilla };
        var whole = new JsonObject
        {
            ["mods"] = new JsonArray(new JsonObject { ["name"] = Mod, ["folder"] = ModFolder, ["installationFiles"] = new JsonArray(installationFile) }),
            ["gameFiles"] = new JsonArray(gameFile),
        };
        return (whole, installationFile, gameFile);
    }

    private Task<HttpResponseMessage> Stage(string downloadName) => Client.PostAsJsonAsync("/modlist/stage", Request(downloadName).Whole);

    [Theory]
    [InlineData("installationFile", "size")]
    [InlineData("installationFile", "hash")]
    [InlineData("installationFile", "entries")]
    [InlineData("request", "gameFiles")]
    [InlineData("gameFile", "path")]
    [InlineData("gameFile", "size")]
    [InlineData("gameFile", "hash")]
    public async Task StagingWithAFieldMissing_Is400(string holder, string field)
    {
        ModInstalledFromADownload(editedText: "original");
        var request = Request("Mod.zip");
        (holder switch
        {
            "installationFile" => request.InstallationFile,
            "gameFile" => request.GameFile,
            _ => request.Whole,
        }).Remove(field);

        var response = await Client.PostAsJsonAsync("/modlist/stage", request.Whole);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task StagingAMod_AnswersItLanded_ReportsEachFileNothingProvides_WritesItsManifest_AndReportsItsProgress()
    {
        ModInstalledFromADownload(editedText: "changed");
        using var stream = await Client.NotificationStream();

        var response = await Stage("Mod.zip");

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var staged = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal((Mod, true), (staged.GetProperty("mod").GetString(), staged.GetProperty("manifestWritten").GetBoolean()));
        Assert.Equal(["edited.txt"], staged.GetProperty("noProvider").EnumerateArray().Select(p => p.GetString()));
        Assert.Empty(body.GetProperty("refused").EnumerateArray());
        var manifest = File.ReadAllLines(Path.Combine(ModFolder, Mod + ".manifest"));
        Assert.Equal("{\"installationFile\":\"Mod.zip\",\"size\":7,\"hash\":\"WHOLE\",\"source\":\"nexus:1:2\"}", manifest[0]);
        Assert.Equal($"{{\"gameFile\":\"Game.esm\",\"size\":7,\"hash\":\"{HashOfVanilla}\"}}", manifest[1]);
        Assert.Equal(
            ["Game.esm", "edited.txt", "kept.txt"],
            manifest.Skip(2).Select(line => JsonDocument.Parse(line).RootElement.GetProperty("path").GetString()));
        var progress = await stream.EventsUntil("stage-progress", e => e.GetProperty("stageProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("stageProgress").GetProperty("mod").GetString() == Mod);
    }

    [Fact]
    public async Task StagingAModAgain_AnswersItsManifestNotWritten()
    {
        ModInstalledFromADownload(editedText: "original");
        (await Stage("Mod.zip")).EnsureSuccessStatusCode();

        var body = await (await Stage("Mod.zip")).Content.ReadFromJsonAsync<JsonElement>();

        var staged = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.False(staged.GetProperty("manifestWritten").GetBoolean());
        Assert.Empty(staged.GetProperty("noProvider").EnumerateArray());
    }

    [Fact]
    public async Task StagingAModWhoseInstallationFileIsMissing_RefusesItNamingTheFile_AndWritesNoManifest()
    {
        ModInstalledFromADownload(editedText: "original");

        var body = await (await Stage("Absent.zip")).Content.ReadFromJsonAsync<JsonElement>();

        var refused = Assert.Single(body.GetProperty("refused").EnumerateArray());
        Assert.Equal(("InstallationFileMissing", Mod), (refused.GetProperty("refusal").GetString(), refused.GetProperty("item").GetString()));
        Assert.Contains("Absent.zip", refused.GetProperty("message").GetString());
        Assert.False(File.Exists(Path.Combine(ModFolder, Mod + ".manifest")));
    }

    [Fact]
    public async Task StagingNoMod_Is400()
    {
        var response = await Client.PostAsJsonAsync("/modlist/stage", new { mods = Array.Empty<object>(), gameFiles = Array.Empty<object>() });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
