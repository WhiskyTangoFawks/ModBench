using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
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

    private Task<HttpResponseMessage> Stage(string downloadName) =>
        Client.PostAsJsonAsync("/modlist/stage", new
        {
            mods = new[]
            {
                new
                {
                    name = Mod,
                    folder = ModFolder,
                    installationFiles = new[]
                    {
                        new
                        {
                            path = Path.Combine(Downloads, downloadName),
                            source = "nexus:1:2",
                            size = 7,
                            hash = "WHOLE",
                            entries = new[] { new { path = "kept.txt", hash = HashOfKept }, new { path = "edited.txt", hash = HashOfOriginal } },
                        },
                    },
                },
            },
            gameFiles = new[] { new { path = "Game.esm", size = 7, hash = HashOfVanilla } },
        });

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
