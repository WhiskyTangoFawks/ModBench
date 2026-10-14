using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Traces;

public sealed class RestoreFromManifestTraceTests : HostedTests
{
    private const string Mod = "DiscardedMod";
    private const string HashOfKept = "gO3vE0ddOto=";
    private const string HashOfOriginal = "PclCUmd0Z4s=";
    private const string HashOfVanilla = "/Qk9lLVYbZs=";
    private const string HashOfTheZip = "AAECAwQFBgc=";

    private readonly ScratchDirectory _instance = new("trace-discard-changes-");

    protected override void DisposeFixtures() => _instance.Dispose();

    private string ModFolder => Path.Combine(_instance, "mods", Mod);

    private string Downloads => Path.Combine(_instance, "downloads");

    private static string Original => string.Concat(Enumerable.Range(0, 1000).Select(line => $"{line:D7}\n"));

    private static string Edited => Original.Replace("0000500", "edited!", StringComparison.Ordinal);

    private string FileText(string path) => File.ReadAllText(Path.Combine(ModFolder, path));

    private void ModInstalledFromADownload_ThenEdited()
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "kept.txt"), "kept");
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), Edited);
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
            ["dataFolder"] = Path.Combine(_instance, "game", "Data"),
            ["buildFolder"] = Path.Combine(_instance, "build"),
        };
        if (gesture == "stage") request["deltaShare"] = 0.5;
        else request["downloadsFolder"] = Downloads;
        return request;
    }

    private async Task<JsonElement> Post(string gesture, string downloadName = "Mod.zip")
    {
        var response = await Client.PostAsJsonAsync($"/modlist/{gesture}", Request(gesture, downloadName));
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task DiscardingAModJustStaged_WritesNoFile()
    {
        ModInstalledFromADownload_ThenEdited();
        await Post("stage");

        var body = await Post("discard-changes");

        var discarded = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal(Mod, discarded.GetProperty("mod").GetString());
        Assert.Empty(discarded.GetProperty("written").EnumerateArray());
        Assert.Empty(body.GetProperty("refused").EnumerateArray());
    }

    [Fact]
    public async Task DiscardingAModChangedSinceItsStage_BringsEveryFileBack_AnEditedOneThroughItsDelta_AGameFilesFromTheGame_AndLeavesAnUntrackedFile()
    {
        ModInstalledFromADownload_ThenEdited();
        await Post("stage");
        Directory.CreateDirectory(Path.Combine(_instance, "game", "Data"));
        File.WriteAllText(Path.Combine(_instance, "game", "Data", "Game.esm"), "vanilla");
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), Original);
        File.Delete(Path.Combine(ModFolder, "kept.txt"));
        File.Delete(Path.Combine(ModFolder, "Game.esm"));
        File.WriteAllText(Path.Combine(ModFolder, "untracked.txt"), "mine");
        using var stream = await Client.NotificationStream();

        var body = await Post("discard-changes");

        var discarded = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal(
            ["Game.esm", "edited.txt", "kept.txt"], discarded.GetProperty("written").EnumerateArray().Select(path => path.GetString()).Order(StringComparer.Ordinal));
        Assert.Equal(
            (Edited, "kept", "vanilla", "mine"), (FileText("edited.txt"), FileText("kept.txt"), FileText("Game.esm"), FileText("untracked.txt")));
        var progress = await stream.EventsUntil("discard-progress", e => e.GetProperty("modlistProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("modlistProgress").GetProperty("mod").GetString() == Mod);
    }

    [Theory]
    [InlineData("mods", "[]")]
    [InlineData("gameFiles", null)]
    [InlineData("dataFolder", null)]
    [InlineData("buildFolder", null)]
    [InlineData("downloadedFiles", "[{\"path\":\"d.zip\",\"size\":1,\"hash\":\"WHOLE\",\"entries\":[]}]")]
    public async Task DiscardingWithAFieldMissingOrMalformed_Is400(string field, string? json)
    {
        var request = Request("discard-changes", "Mod.zip");
        if (json is null) request.Remove(field);
        else request[field] = JsonNode.Parse(json);

        var response = await Client.PostAsJsonAsync("/modlist/discard-changes", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
