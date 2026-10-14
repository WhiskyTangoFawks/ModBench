using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Http.Tests.Api;

public sealed class RestoreFromManifestApiTests : HostedTests
{
    private const string Mod = "RestoredMod";
    private const string HashOfKept = "gO3vE0ddOto=";
    private const string HashOfOriginal = "PclCUmd0Z4s=";
    private const string HashOfVanilla = "/Qk9lLVYbZs=";
    private const string HashOfTheZip = "AAECAwQFBgc=";
    private const string Gesture = "a-gesture";

    private readonly ScratchDirectory _instance = new("restore-from-manifest-");

    protected override MEditHost CreateHost() => new(services => services.AddSingleton<TimeProvider>(new ADayAhead()));

    protected override void DisposeFixtures() => _instance.Dispose();

    private string ModFolder => Path.Combine(_instance, "mods", Mod);

    private string Downloads => Path.Combine(_instance, "downloads");

    private static string Original => string.Concat(Enumerable.Range(0, 1000).Select(line => $"{line:D7}\n"));

    private string FileText(string path) => File.ReadAllText(Path.Combine(ModFolder, path));

    private void ModInstalledFromADownload()
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "kept.txt"), "kept");
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), Original);
        File.WriteAllText(Path.Combine(ModFolder, "Game.esm"), "vanilla");
        Directory.CreateDirectory(Downloads);
        using var zip = ZipFile.Open(Path.Combine(Downloads, "Mod.zip"), ZipArchiveMode.Create);
        foreach (var (entry, content) in new[] { ("kept.txt", "kept"), ("edited.txt", Original) })
        {
            using var writer = new StreamWriter(zip.CreateEntry(entry).Open());
            writer.Write(content);
        }
    }

    private JsonObject Request(string gesture, string downloadName)
    {
        var installationFile = new JsonObject
        {
            ["path"] = Path.Combine(Downloads, downloadName),
            ["size"] = 7,
            ["hash"] = HashOfTheZip,
            ["entries"] = new JsonArray(
                new JsonObject { ["path"] = "kept.txt", ["hash"] = HashOfKept }, new JsonObject { ["path"] = "edited.txt", ["hash"] = HashOfOriginal }),
        };
        var request = new JsonObject
        {
            ["mods"] = new JsonArray(new JsonObject { ["name"] = Mod, ["folder"] = ModFolder, ["installationFiles"] = new JsonArray(installationFile) }),
            ["gameFiles"] = new JsonArray(new JsonObject { ["path"] = "Game.esm", ["size"] = 7, ["hash"] = HashOfVanilla }),
            ["statCache"] = Path.Combine(_instance, "stat-cache"),
            ["gesture"] = Gesture,
        };
        if (gesture == "restore-from-manifest") request["dataFolder"] = Path.Combine(_instance, "game", "Data");
        return request;
    }

    private async Task<JsonElement> Post(string gesture, string downloadName = "Mod.zip")
    {
        var response = await Client.PostAsJsonAsync($"/{gesture}", Request(gesture, downloadName));
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task RestoringAModJustUpdated_OpensNoFileTheUpdateRead_AndWritesNoFile()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        using var held = new FileStream(Path.Combine(ModFolder, "kept.txt"), FileMode.Open, FileAccess.Read, FileShare.None);

        var body = await Post("restore-from-manifest");

        var restored = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal(Mod, restored.GetProperty("mod").GetString());
        Assert.Empty(restored.GetProperty("written").EnumerateArray());
        Assert.Empty(body.GetProperty("refused").EnumerateArray());
    }

    [Fact]
    public async Task RestoringAModWhoseStatCacheCannotBeWritten_LandsNamingWhy()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        var taken = Path.Combine(_instance, "taken");
        File.WriteAllText(taken, "a file where the stat cache's folder would be");
        var request = Request("restore-from-manifest", "Mod.zip");
        request["statCache"] = taken;

        var response = await Client.PostAsJsonAsync("/restore-from-manifest", request);

        var restored = Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("applied").EnumerateArray());
        Assert.Contains(taken, restored.GetProperty("statCacheNotWritten").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task RestoringAModChangedSinceItsUpdate_BringsEveryFileBack_AGameFilesFromTheGame_LeavesAnUntrackedFile_AndReportsItsProgressUnderItsGesture()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        Directory.CreateDirectory(Path.Combine(_instance, "game", "Data"));
        File.WriteAllText(Path.Combine(_instance, "game", "Data", "Game.esm"), "vanilla");
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), "edited");
        File.Delete(Path.Combine(ModFolder, "kept.txt"));
        File.Delete(Path.Combine(ModFolder, "Game.esm"));
        File.WriteAllText(Path.Combine(ModFolder, "untracked.txt"), "mine");
        using var stream = await Client.NotificationStream();

        var body = await Post("restore-from-manifest");

        var restored = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal(
            ["Game.esm", "edited.txt", "kept.txt"], restored.GetProperty("written").EnumerateArray().Select(path => path.GetString()).Order(StringComparer.Ordinal));
        Assert.Equal(
            (Original, "kept", "vanilla", "mine"), (FileText("edited.txt"), FileText("kept.txt"), FileText("Game.esm"), FileText("untracked.txt")));
        var progress = await stream.EventsUntil("restore-from-manifest-progress", e => e.GetProperty("modlistProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("modlistProgress").GetProperty("mod").GetString() == Mod);
        Assert.All(progress, e => Assert.Equal(Gesture, e.GetProperty("modlistProgress").GetProperty("gesture").GetString()));
    }

    [Theory]
    [InlineData("mods", "[]")]
    [InlineData("gameFiles", null)]
    [InlineData("dataFolder", null)]
    [InlineData("statCache", null)]
    public async Task RestoringWithAFieldMissingOrMalformed_Is400(string field, string? json)
    {
        var request = Request("restore-from-manifest", "Mod.zip");
        if (json is null) request.Remove(field);
        else request[field] = JsonNode.Parse(json);

        var response = await Client.PostAsJsonAsync("/restore-from-manifest", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
