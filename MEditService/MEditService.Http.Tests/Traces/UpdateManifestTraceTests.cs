using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Http.Tests.TestSupport;
using MEditService.ModFolderAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Http.Tests.Api;

public sealed class UpdateManifestTraceTests : HostedTests
{
    private const string Mod = "UpdatedMod";
    private const string HashOfKept = "gO3vE0ddOto=";
    private const string HashOfOriginal = "PclCUmd0Z4s=";
    private const string HashOfTheZip = "AAECAwQFBgc=";
    private const string Gesture = "a-gesture";

    private readonly ScratchDirectory _instance = new("trace-update-manifest-");

    protected override MEditHost CreateHost() => new(services => services.AddSingleton<TimeProvider>(new ADayAhead()));

    protected override void DisposeFixtures() => _instance.Dispose();

    private string ModFolder => Path.Combine(_instance, "mods", Mod);

    private string Downloads => Path.Combine(_instance, "downloads");

    private static string Original => string.Concat(Enumerable.Range(0, 1000).Select(line => $"{line:D7}\n"));

    private void ModInstalledFromADownload(bool edited)
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "kept.txt"), "kept");
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), edited ? "edited" : Original);
        Directory.CreateDirectory(Downloads);
        using var zip = ZipFile.Open(Path.Combine(Downloads, "Mod.zip"), ZipArchiveMode.Create);
        foreach (var (entry, content) in new[] { ("kept.txt", "kept"), ("edited.txt", Original) })
        {
            using var writer = new StreamWriter(zip.CreateEntry(entry).Open());
            writer.Write(content);
        }
    }

    private (JsonObject Whole, JsonObject InstallationFile, JsonObject Entry) Request(string downloadName)
    {
        var entry = new JsonObject { ["path"] = "kept.txt", ["hash"] = HashOfKept };
        var installationFile = new JsonObject
        {
            ["path"] = Path.Combine(Downloads, downloadName),
            ["page"] = "https://www.nexusmods.com/fallout4/mods/1",
            ["size"] = 7,
            ["hash"] = HashOfTheZip,
            ["entries"] = new JsonArray(entry, new JsonObject { ["path"] = "edited.txt", ["hash"] = HashOfOriginal }),
        };
        var whole = new JsonObject
        {
            ["mods"] = new JsonArray(new JsonObject { ["name"] = Mod, ["folder"] = ModFolder, ["version"] = "1.2.3", ["installationFile"] = installationFile }),
            ["statCache"] = Path.Combine(_instance, "stat-cache"),
            ["gesture"] = Gesture,
        };
        return (whole, installationFile, entry);
    }

    private Task<HttpResponseMessage> UpdateManifest(string downloadName) => Client.PostAsJsonAsync("/update-manifest", Request(downloadName).Whole);

    [Theory]
    [InlineData("installationFile", "size", null)]
    [InlineData("installationFile", "hash", null)]
    [InlineData("installationFile", "hash", "\"WHOLE\"")]
    [InlineData("installationFile", "entries", null)]
    [InlineData("entry", "hash", "\"WHOLE\"")]
    [InlineData("request", "statCache", null)]
    public async Task UpdatingAManifestWithAFieldMissingOrMalformed_Is400(string holder, string field, string? json)
    {
        ModInstalledFromADownload(edited: false);
        var request = Request("Mod.zip");
        var held = holder switch
        {
            "installationFile" => request.InstallationFile,
            "entry" => request.Entry,
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
        Assert.Equal(["edited.txt"], updated.GetProperty("notInPackage").EnumerateArray().Select(path => path.GetString()));
        Assert.Empty(body.GetProperty("refused").EnumerateArray());
        Assert.Equal(
            "{\n"
            + $"\"package\": {{\"installationFile\":\"Mod.zip\",\"size\":7,\"hash\":\"{HashOfTheZip}\",\"page\":\"https://www.nexusmods.com/fallout4/mods/1\",\"version\":\"1.2.3\"}},\n"
            + "\"files\": [\n"
            + "{\"path\":\"edited.txt\",\"inPackage\":false},\n"
            + "{\"path\":\"kept.txt\"}\n"
            + "]\n"
            + "}\n",
            File.ReadAllText(Path.Combine(ModFolder, Mod + ".manifest.json")));
        var progress = await stream.EventsUntil("update-manifest-progress", e => e.GetProperty("modlistProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("modlistProgress").GetProperty("mod").GetString() == Mod);
        Assert.All(progress, e => Assert.Equal(Gesture, e.GetProperty("modlistProgress").GetProperty("gesture").GetString()));
    }

    private JsonObject GameFolderRequest(out string hash) => GameFolderRequest(out hash, out _, out _);

    private JsonObject GameFolderRequest(out string hash, out JsonObject gameFolder, out JsonObject file)
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "a.nif"), "taken");
        hash = new ModFolderRepository(TimeProvider.System).Files(ModFolder, Mod, new HashSet<string>(), null).Files.Single().Hash;
        file = new JsonObject { ["path"] = "A.nif", ["hash"] = hash };
        gameFolder = new JsonObject { ["name"] = "Fallout4", ["dataFolder"] = Path.Combine(_instance, "game", "Data"), ["files"] = new JsonArray(file) };
        return new JsonObject
        {
            ["mods"] = new JsonArray(new JsonObject { ["name"] = Mod, ["folder"] = ModFolder, ["metadataFiles"] = new JsonArray() }),
            ["statCache"] = Path.Combine(_instance, "stat-cache"),
            ["gameFolder"] = gameFolder,
        };
    }

    [Theory]
    [InlineData("name", null)]
    [InlineData("dataFolder", null)]
    [InlineData("files", null)]
    [InlineData("hash", "\"WHOLE\"")]
    public async Task UpdatingAManifestWithAGameFolderMissingAFieldOrMalformed_Is400(string field, string? json)
    {
        var request = GameFolderRequest(out _, out var gameFolder, out var file);
        var held = field == "hash" ? file : gameFolder;
        if (json is null) held.Remove(field);
        else held[field] = JsonNode.Parse(json);

        var response = await Client.PostAsJsonAsync("/update-manifest", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task UpdatingTheManifestOfAModWhoseFilesTheGameFolderHolds_NamesTheGameFolderAsItsPackage()
    {
        var request = GameFolderRequest(out var hash);

        var response = await Client.PostAsJsonAsync("/update-manifest", request);

        response.EnsureSuccessStatusCode();
        var pin = FileHash.OfFilesTaken([new HashedFile("a.nif", hash)]);
        Assert.Equal(
            $"{{\n\"package\": {{\"gameFolder\":\"Fallout4\",\"hash\":\"{pin}\"}},\n\"files\": [\n{{\"path\":\"a.nif\"}}\n]\n}}\n",
            File.ReadAllText(Path.Combine(ModFolder, Mod + ".manifest.json")));
    }

    [Fact]
    public async Task UpdatingTheManifestsOfNoMod_Is400()
    {
        var response = await Client.PostAsJsonAsync("/update-manifest", new { mods = Array.Empty<object>() });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
