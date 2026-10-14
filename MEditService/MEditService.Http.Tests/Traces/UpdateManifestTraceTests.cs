using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class UpdateManifestTraceTests : HostedTests
{
    private const string Mod = "UpdatedMod";
    private const string HashOfKept = "gO3vE0ddOto=";
    private const string HashOfOriginal = "PclCUmd0Z4s=";
    private const string HashOfVanilla = "/Qk9lLVYbZs=";
    private const string HashOfTheZip = "AAECAwQFBgc=";
    private const string Gesture = "a-gesture";

    private readonly ScratchDirectory _instance = new("trace-update-manifest-");

    protected override void DisposeFixtures() => _instance.Dispose();

    private string ModFolder => Path.Combine(_instance, "mods", Mod);

    private string Downloads => Path.Combine(_instance, "downloads");

    private static string Original => string.Concat(Enumerable.Range(0, 1000).Select(line => $"{line:D7}\n"));

    private void ModInstalledFromADownload(bool edited)
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "kept.txt"), "kept");
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), edited ? "edited" : Original);
        File.WriteAllText(Path.Combine(ModFolder, "Game.esm"), "vanilla");
        Directory.CreateDirectory(Downloads);
        using var zip = ZipFile.Open(Path.Combine(Downloads, "Mod.zip"), ZipArchiveMode.Create);
        foreach (var (entry, content) in new[] { ("kept.txt", "kept"), ("edited.txt", Original) })
        {
            using var writer = new StreamWriter(zip.CreateEntry(entry).Open());
            writer.Write(content);
        }
    }

    private (JsonObject Whole, JsonObject InstallationFile, JsonObject Entry, JsonObject GameFile) Request(string downloadName)
    {
        var entry = new JsonObject { ["path"] = "kept.txt", ["hash"] = HashOfKept };
        var installationFile = new JsonObject
        {
            ["path"] = Path.Combine(Downloads, downloadName),
            ["source"] = "nexus:1:2",
            ["size"] = 7,
            ["hash"] = HashOfTheZip,
            ["entries"] = new JsonArray(entry, new JsonObject { ["path"] = "edited.txt", ["hash"] = HashOfOriginal }),
        };
        var gameFile = new JsonObject { ["path"] = "Game.esm", ["size"] = 7, ["hash"] = HashOfVanilla };
        var whole = new JsonObject
        {
            ["mods"] = new JsonArray(new JsonObject { ["name"] = Mod, ["folder"] = ModFolder, ["installationFiles"] = new JsonArray(installationFile) }),
            ["gameFiles"] = new JsonArray(gameFile),
            ["gesture"] = Gesture,
        };
        return (whole, installationFile, entry, gameFile);
    }

    private Task<HttpResponseMessage> UpdateManifest(string downloadName) => Client.PostAsJsonAsync("/update-manifest", Request(downloadName).Whole);

    [Theory]
    [InlineData("installationFile", "size", null)]
    [InlineData("installationFile", "hash", null)]
    [InlineData("installationFile", "hash", "\"WHOLE\"")]
    [InlineData("installationFile", "entries", null)]
    [InlineData("entry", "hash", "\"WHOLE\"")]
    [InlineData("request", "gameFiles", null)]
    [InlineData("gameFile", "path", null)]
    [InlineData("gameFile", "size", null)]
    [InlineData("gameFile", "hash", null)]
    [InlineData("gameFile", "hash", "\"WHOLE\"")]
    public async Task UpdatingAManifestWithAFieldMissingOrMalformed_Is400(string holder, string field, string? json)
    {
        ModInstalledFromADownload(edited: false);
        var request = Request("Mod.zip");
        var held = holder switch
        {
            "installationFile" => request.InstallationFile,
            "entry" => request.Entry,
            "gameFile" => request.GameFile,
            _ => request.Whole,
        };
        if (json is null) held.Remove(field);
        else held[field] = JsonNode.Parse(json);

        var response = await Client.PostAsJsonAsync("/update-manifest", request.Whole);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task UpdatingTheManifestOfAMod_AnswersItLanded_WritesItsManifest_AndReportsItsProgressUnderItsGesture()
    {
        ModInstalledFromADownload(edited: true);
        using var stream = await Client.NotificationStream();

        var response = await UpdateManifest("Mod.zip");

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var updated = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal((Mod, true), (updated.GetProperty("mod").GetString(), updated.GetProperty("manifestWritten").GetBoolean()));
        Assert.Equal(["edited.txt"], updated.GetProperty("noProvider").EnumerateArray().Select(path => path.GetString()));
        Assert.Empty(body.GetProperty("refused").EnumerateArray());
        var manifest = File.ReadAllLines(Path.Combine(ModFolder, Mod + ".manifest"));
        Assert.Equal($"{{\"installationFile\":\"Mod.zip\",\"size\":7,\"hash\":\"{HashOfTheZip}\",\"source\":\"nexus:1:2\"}}", manifest[0]);
        Assert.Equal($"{{\"gameFile\":\"Game.esm\",\"size\":7,\"hash\":\"{HashOfVanilla}\"}}", manifest[1]);
        Assert.Equal(
            ["Game.esm", "edited.txt", "kept.txt"],
            manifest.Skip(2).Select(line => JsonDocument.Parse(line).RootElement.GetProperty("path").GetString()));
        Assert.Equal(JsonValueKind.Null, JsonDocument.Parse(manifest[3]).RootElement.GetProperty("from").ValueKind);
        Assert.All(manifest.Skip(2), line => Assert.False(JsonDocument.Parse(line).RootElement.TryGetProperty("hash", out _)));
        var progress = await stream.EventsUntil("update-manifest-progress", e => e.GetProperty("modlistProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("modlistProgress").GetProperty("mod").GetString() == Mod);
        Assert.All(progress, e => Assert.Equal(Gesture, e.GetProperty("modlistProgress").GetProperty("gesture").GetString()));
    }

    [Fact]
    public async Task UpdatingTheManifestOfAModAgain_AnswersItsManifestNotWritten()
    {
        ModInstalledFromADownload(edited: false);
        (await UpdateManifest("Mod.zip")).EnsureSuccessStatusCode();

        var body = await (await UpdateManifest("Mod.zip")).Content.ReadFromJsonAsync<JsonElement>();

        var updated = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.False(updated.GetProperty("manifestWritten").GetBoolean());
        Assert.Empty(updated.GetProperty("noProvider").EnumerateArray());
    }

    [Fact]
    public async Task UpdatingTheManifestOfAModWhoseInstallationFileIsMissing_RefusesItNamingTheFile_AndWritesNoManifest()
    {
        ModInstalledFromADownload(edited: false);

        var body = await (await UpdateManifest("Absent.zip")).Content.ReadFromJsonAsync<JsonElement>();

        var refused = Assert.Single(body.GetProperty("refused").EnumerateArray());
        Assert.Equal(("InstallationFileMissing", Mod), (refused.GetProperty("refusal").GetString(), refused.GetProperty("item").GetString()));
        Assert.Contains("Absent.zip", refused.GetProperty("message").GetString());
        Assert.False(File.Exists(Path.Combine(ModFolder, Mod + ".manifest")));
    }

    [Fact]
    public async Task UpdatingTheManifestsOfNoMod_Is400()
    {
        var response = await Client.PostAsJsonAsync("/update-manifest", new { mods = Array.Empty<object>(), gameFiles = Array.Empty<object>() });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
