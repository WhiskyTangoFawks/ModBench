using System.IO.Compression;
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
    private const string HashOfOriginal = "PclCUmd0Z4s=";
    private const string HashOfVanilla = "/Qk9lLVYbZs=";

    private readonly ScratchDirectory _instance = new("trace-stage-modlist-");

    protected override void DisposeFixtures() => _instance.Dispose();

    private string ModFolder => Path.Combine(_instance, "mods", Mod);

    private string Downloads => Path.Combine(_instance, "downloads");

    private string BuildFolder => Path.Combine(_instance, "build");

    private static string Original => string.Concat(Enumerable.Range(0, 1000).Select(line => $"{line:D7}\n"));

    private void ModInstalledFromADownload(bool edited)
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "kept.txt"), "kept");
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), edited ? Original.Replace("0000500", "edited!", StringComparison.Ordinal) : Original);
        File.WriteAllText(Path.Combine(ModFolder, "Game.esm"), "vanilla");
        Directory.CreateDirectory(Downloads);
        using var zip = ZipFile.Open(Path.Combine(Downloads, "Mod.zip"), ZipArchiveMode.Create);
        foreach (var (entry, content) in new[] { ("kept.txt", "kept"), ("edited.txt", Original) })
        {
            using var writer = new StreamWriter(zip.CreateEntry(entry).Open());
            writer.Write(content);
        }
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
            ["dataFolder"] = Path.Combine(_instance, "game", "Data"),
            ["buildFolder"] = BuildFolder,
            ["deltaShare"] = 0.5,
        };
        return (whole, installationFile, gameFile);
    }

    private Task<HttpResponseMessage> Stage(string downloadName) => Client.PostAsJsonAsync("/modlist/stage", Request(downloadName).Whole);

    [Theory]
    [InlineData("installationFile", "size")]
    [InlineData("installationFile", "hash")]
    [InlineData("installationFile", "entries")]
    [InlineData("request", "gameFiles")]
    [InlineData("request", "dataFolder")]
    [InlineData("request", "buildFolder")]
    [InlineData("request", "deltaShare")]
    [InlineData("gameFile", "path")]
    [InlineData("gameFile", "size")]
    [InlineData("gameFile", "hash")]
    public async Task StagingWithAFieldMissing_Is400(string holder, string field)
    {
        ModInstalledFromADownload(edited: false);
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

    [Theory]
    [InlineData(-0.1)]
    [InlineData(1.1)]
    public async Task StagingWithADeltaShareOutside0To1_Is400(double share)
    {
        ModInstalledFromADownload(edited: false);
        var request = Request("Mod.zip").Whole;
        request["deltaShare"] = share;

        var response = await Client.PostAsJsonAsync("/modlist/stage", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task StagingAMod_AnswersItLanded_WritesItsManifestAndEachDelta_AndReportsItsProgress()
    {
        ModInstalledFromADownload(edited: true);
        using var stream = await Client.NotificationStream();

        var response = await Stage("Mod.zip");

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var staged = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal((Mod, true), (staged.GetProperty("mod").GetString(), staged.GetProperty("manifestWritten").GetBoolean()));
        Assert.Empty(staged.GetProperty("noProvider").EnumerateArray());
        Assert.Empty(body.GetProperty("refused").EnumerateArray());
        var manifest = File.ReadAllLines(Path.Combine(ModFolder, Mod + ".manifest"));
        Assert.Equal("{\"installationFile\":\"Mod.zip\",\"size\":7,\"hash\":\"WHOLE\",\"source\":\"nexus:1:2\"}", manifest[0]);
        Assert.Equal($"{{\"gameFile\":\"Game.esm\",\"size\":7,\"hash\":\"{HashOfVanilla}\"}}", manifest[1]);
        Assert.Equal(
            ["Game.esm", "edited.txt", "kept.txt"],
            manifest.Skip(2).Select(line => JsonDocument.Parse(line).RootElement.GetProperty("path").GetString()));
        const string Delta = "edited.txt.3dc942526774678b_9de9edf07b967acb.octodiff";
        Assert.Equal(
            $"{{\"installationFile\":\"Mod.zip\",\"path\":\"edited.txt\",\"delta\":\"{Delta}\"}}",
            JsonDocument.Parse(manifest[3]).RootElement.GetProperty("from").GetRawText());
        Assert.Equal([Delta], Directory.GetFiles(BuildFolder).Select(Path.GetFileName));
        var progress = await stream.EventsUntil("stage-progress", e => e.GetProperty("stageProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("stageProgress").GetProperty("mod").GetString() == Mod);
    }

    [Fact]
    public async Task StagingAModAgain_AnswersItsManifestNotWritten()
    {
        ModInstalledFromADownload(edited: false);
        (await Stage("Mod.zip")).EnsureSuccessStatusCode();

        var body = await (await Stage("Mod.zip")).Content.ReadFromJsonAsync<JsonElement>();

        var staged = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.False(staged.GetProperty("manifestWritten").GetBoolean());
        Assert.Empty(staged.GetProperty("noProvider").EnumerateArray());
    }

    [Fact]
    public async Task StagingAModWhoseInstallationFileIsMissing_RefusesItNamingTheFile_AndWritesNoManifest()
    {
        ModInstalledFromADownload(edited: false);

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
