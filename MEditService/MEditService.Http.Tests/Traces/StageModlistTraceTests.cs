using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Traces;

public sealed class StageModlistTraceTests : HostedTests
{
    private const string Mod = "StagedMod";

    private readonly ScratchDirectory _instance = new("trace-stage-modlist-");

    protected override void DisposeFixtures() => _instance.Dispose();

    private string ModFolder => Path.Combine(_instance, "mods", Mod);

    private string Downloads => Path.Combine(_instance, "downloads");

    private void ModInstalledFromAnArchive(string archiveName, string editedText)
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "kept.txt"), "kept");
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), editedText);
        Directory.CreateDirectory(Downloads);
        using var archive = new ZipArchive(File.Create(Path.Combine(Downloads, archiveName)), ZipArchiveMode.Create);
        foreach (var (path, text) in new[] { ("kept.txt", "kept"), ("edited.txt", "original") })
        {
            using var entry = archive.CreateEntry(path).Open();
            entry.Write(Encoding.ASCII.GetBytes(text));
        }
    }

    private Task<HttpResponseMessage> Stage(string archiveName) =>
        Client.PostAsJsonAsync("/modlist/stage", new
        {
            mods = new[]
            {
                new
                {
                    name = Mod,
                    folder = ModFolder,
                    installationFiles = new[] { new { path = Path.Combine(Downloads, archiveName), source = "nexus:1:2" } },
                },
            },
            dataFolder = Path.Combine(_instance, "game"),
        });

    [Fact]
    public async Task StagingAMod_AnswersItLanded_ReportsEachFileNothingProvides_WritesItsManifest_AndReportsItsProgress()
    {
        ModInstalledFromAnArchive("Mod.zip", editedText: "changed");
        using var stream = await Client.NotificationStream();

        var response = await Stage("Mod.zip");

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var staged = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal((Mod, true), (staged.GetProperty("mod").GetString(), staged.GetProperty("manifestWritten").GetBoolean()));
        Assert.Equal(["edited.txt"], staged.GetProperty("noProvider").EnumerateArray().Select(p => p.GetString()));
        Assert.Empty(body.GetProperty("refused").EnumerateArray());
        var manifest = File.ReadAllLines(Path.Combine(ModFolder, Mod + ".manifest"));
        Assert.Contains("\"source\":\"nexus:1:2\"", manifest[0]);
        Assert.Equal(["edited.txt", "kept.txt"], manifest.Skip(1).Select(line => JsonDocument.Parse(line).RootElement.GetProperty("path").GetString()));
        var progress = await stream.EventsUntil("stage-progress", e => e.GetProperty("stageProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("stageProgress").GetProperty("mod").GetString() == Mod);
    }

    [Fact]
    public async Task StagingAModAgain_AnswersItsManifestNotWritten()
    {
        ModInstalledFromAnArchive("Mod.zip", editedText: "original");
        (await Stage("Mod.zip")).EnsureSuccessStatusCode();

        var body = await (await Stage("Mod.zip")).Content.ReadFromJsonAsync<JsonElement>();

        var staged = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.False(staged.GetProperty("manifestWritten").GetBoolean());
        Assert.Empty(staged.GetProperty("noProvider").EnumerateArray());
    }

    [Fact]
    public async Task StagingAModWhoseInstallationFileIsMissing_RefusesItNamingTheFile_AndWritesNoManifest()
    {
        ModInstalledFromAnArchive("Mod.zip", editedText: "original");

        var body = await (await Stage("Absent.zip")).Content.ReadFromJsonAsync<JsonElement>();

        var refused = Assert.Single(body.GetProperty("refused").EnumerateArray());
        Assert.Equal(("InstallationFileMissing", Mod), (refused.GetProperty("refusal").GetString(), refused.GetProperty("item").GetString()));
        Assert.Contains("Absent.zip", refused.GetProperty("message").GetString());
        Assert.False(File.Exists(Path.Combine(ModFolder, Mod + ".manifest")));
    }

    [Fact]
    public async Task StagingNoMod_Is400()
    {
        var response = await Client.PostAsJsonAsync("/modlist/stage", new { mods = Array.Empty<object>(), dataFolder = "game" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
