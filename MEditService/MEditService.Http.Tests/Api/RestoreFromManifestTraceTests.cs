using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Http.Tests.Api;

public sealed class RestoreFromManifestTraceTests : HostedTests
{
    private const string Mod = "RestoredMod";
    private const string HashOfKept = "gO3vE0ddOto=";
    private const string HashOfOriginal = "PclCUmd0Z4s=";
    private const string HashOfVanilla = "/Qk9lLVYbZs=";
    private const string HashOfTheZip = "AAECAwQFBgc=";
    private const string Gesture = "a-gesture";

    private readonly ScratchDirectory _instance = new("restore-from-manifest-");

    private string? _versionUpdated;

    protected override MEditHost CreateHost() => new(services => services.AddSingleton<TimeProvider>(new ADayAhead()));

    protected override void DisposeFixtures() => _instance.Dispose();

    private string ModFolder => Path.Combine(_instance, "mods", Mod);

    private string Downloads => Path.Combine(_instance, "downloads");

    private string StatCache => Path.Combine(_instance, "stat-cache");

    private static string Original => string.Concat(Enumerable.Range(0, 1000).Select(line => $"{line:D7}\n"));

    private string FileText(string path) => File.ReadAllText(Path.Combine(ModFolder, path));

    private void ModInstalledFromADownload()
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "kept.txt"), "kept");
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), Original);
        File.WriteAllText(Path.Combine(ModFolder, "Game.esm"), "vanilla");
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "[General]");
        Directory.CreateDirectory(Downloads);
        using var zip = ZipFile.Open(Path.Combine(Downloads, "Mod.zip"), ZipArchiveMode.Create);
        foreach (var (entry, content) in new[] { ("kept.txt", "kept"), ("edited.txt", Original) })
        {
            using var writer = new StreamWriter(zip.CreateEntry(entry).Open());
            writer.Write(content);
        }
    }

    private void ChangedSinceItsUpdate()
    {
        Directory.CreateDirectory(Path.Combine(_instance, "game", "Data"));
        File.WriteAllText(Path.Combine(_instance, "game", "Data", "Game.esm"), "vanilla");
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), "edited");
        File.Delete(Path.Combine(ModFolder, "kept.txt"));
        File.Delete(Path.Combine(ModFolder, "Game.esm"));
        File.WriteAllText(Path.Combine(ModFolder, "untracked.txt"), "mine");
    }

    private JsonObject Request(string gesture, string downloadName, bool handsTheDownload = true)
    {
        var installationFile = new JsonObject
        {
            ["path"] = Path.Combine(Downloads, downloadName),
            ["size"] = 7,
            ["hash"] = HashOfTheZip,
            ["entries"] = new JsonArray(
                new JsonObject { ["path"] = "kept.txt", ["hash"] = HashOfKept }, new JsonObject { ["path"] = "edited.txt", ["hash"] = HashOfOriginal }),
        };
        var mod = new JsonObject
        {
            ["name"] = Mod,
            ["folder"] = ModFolder,
            ["installationFiles"] = handsTheDownload ? new JsonArray(installationFile) : new JsonArray(),
            ["committedFiles"] = new JsonArray("meta.ini"),
            ["version"] = _versionUpdated,
        };
        var request = new JsonObject
        {
            ["mods"] = new JsonArray(mod),
            ["gameFiles"] = new JsonArray(new JsonObject { ["path"] = "Game.esm", ["size"] = 7, ["hash"] = HashOfVanilla }),
            ["statCache"] = StatCache,
            ["gesture"] = Gesture,
        };
        if (gesture == "restore-from-manifest")
        {
            request["dataFolder"] = Path.Combine(_instance, "game", "Data");
            request["excludedSuffix"] = ".mohidden";
        }
        return request;
    }

    private async Task<JsonElement> Post(string gesture, string downloadName = "Mod.zip")
    {
        var response = await Client.PostAsJsonAsync($"/{gesture}", Request(gesture, downloadName));
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private JsonObject WhatRestoreDestroysRequest(JsonObject? metadata = null, string? metadataUnreadable = null) => new()
    {
        ["mods"] = new JsonArray(new JsonObject
        {
            ["name"] = Mod,
            ["folder"] = ModFolder,
            ["committedFiles"] = new JsonArray("meta.ini"),
            ["metadata"] = metadata,
            ["metadataUnreadable"] = metadataUnreadable,
        }),
        ["statCache"] = StatCache,
    };

    private static JsonObject Metadata(string? version) => new() { ["version"] = version, ["installationFiles"] = new JsonArray() };

    private async Task<JsonElement> WhatRestoreDestroys()
    {
        var response = await Client.PostAsJsonAsync("/what-restore-destroys", WhatRestoreDestroysRequest());
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("mods");
    }

    private static IEnumerable<string?> Paths(JsonElement mod, string list) =>
        [.. mod.GetProperty(list).EnumerateArray().Select(path => path.GetString()).Order(StringComparer.Ordinal)];

    [Fact]
    public async Task AModJustUpdated_RestoreDestroysNothing_AndRestoringItOpensNoFileTheUpdateRead_AndWritesNoFile()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        using var held = new FileStream(Path.Combine(ModFolder, "kept.txt"), FileMode.Open, FileAccess.Read, FileShare.None);

        var destroys = await WhatRestoreDestroys();
        var body = await Post("restore-from-manifest");

        Assert.Empty(destroys.EnumerateArray());
        var restored = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal(Mod, restored.GetProperty("mod").GetString());
        Assert.Empty(restored.GetProperty("written").EnumerateArray());
        Assert.Empty(body.GetProperty("refused").EnumerateArray());
    }

    [Fact]
    public async Task AModWhoseMetadataDiffersFromItsManifests_IsListed_AndEachManifestsMetadataIsAnswered()
    {
        ModInstalledFromADownload();
        _versionUpdated = "1.0";
        await Post("update-manifest");

        var response = await Client.PostAsJsonAsync("/what-restore-destroys", WhatRestoreDestroysRequest(Metadata("2.0")));
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        var differing = Assert.Single(body.GetProperty("mods").EnumerateArray());
        Assert.True(differing.GetProperty("metadataDiffers").GetBoolean());
        var manifest = Assert.Single(body.GetProperty("manifests").EnumerateArray());
        Assert.Equal((Mod, "1.0"), (manifest.GetProperty("mod").GetString(), manifest.GetProperty("metadata").GetProperty("version").GetString()));
    }

    private async Task<JsonElement> ModStatus(JsonObject request)
    {
        var response = await Client.PostAsJsonAsync("/mod-status", request);
        response.EnsureSuccessStatusCode();
        return Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("mods").EnumerateArray());
    }

    [Fact]
    public async Task AModWhoseMetadataDiffersFromItsManifests_SaysSoInItsStatus_AndAnswersNoManifestMetadata()
    {
        ModInstalledFromADownload();
        _versionUpdated = "1.0";
        await Post("update-manifest");

        var status = await ModStatus(WhatRestoreDestroysRequest(Metadata("2.0")));

        Assert.True(status.GetProperty("metadataDiffers").GetBoolean());
        Assert.False(status.TryGetProperty("manifestMetadata", out _));
    }

    [Fact]
    public async Task AModWhoseMetadataCouldNotBeRead_IsUnreadableInItsStatus_NamingWhy()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");

        var status = await ModStatus(WhatRestoreDestroysRequest(metadataUnreadable: "access denied"));

        Assert.Contains("access denied", status.GetProperty("unreadable").GetProperty("why").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task RestoringAMod_AnswersTheVersionItsManifestSays()
    {
        ModInstalledFromADownload();
        _versionUpdated = "1.0";
        await Post("update-manifest");

        var restored = Assert.Single((await Post("restore-from-manifest")).GetProperty("applied").EnumerateArray());

        Assert.Equal("1.0", restored.GetProperty("metadata").GetProperty("version").GetString());
    }

    [Fact]
    public async Task AModChangedSinceItsUpdate_ListsWhatRestoreDestroys_ButTheCommittedFiles()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        ChangedSinceItsUpdate();

        var destroys = Assert.Single((await WhatRestoreDestroys()).EnumerateArray());

        Assert.Equal(Mod, destroys.GetProperty("mod").GetString());
        Assert.Equal(["edited.txt"], Paths(destroys, "differing"));
        Assert.Equal(["untracked.txt"], Paths(destroys, "namedByNoLine"));
    }

    [Fact]
    public async Task RestoringAModChangedSinceItsUpdate_BringsEveryFileBack_AGameFilesFromTheGame_NamesEachFileNoLineNames_AndReportsItsProgressUnderItsGesture()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        ChangedSinceItsUpdate();
        using var stream = await Client.NotificationStream();

        var body = await Post("restore-from-manifest");

        var restored = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal(["Game.esm", "edited.txt", "kept.txt"], Paths(restored, "written"));
        Assert.Equal(["untracked.txt"], Paths(restored, "namedByNoLine"));
        Assert.Equal((Original, "kept", "vanilla"), (FileText("edited.txt"), FileText("kept.txt"), FileText("Game.esm")));
        var progress = await stream.EventsUntil("restore-from-manifest-progress", e => e.GetProperty("modlistProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("modlistProgress").GetProperty("mod").GetString() == Mod);
        Assert.All(progress, e => Assert.Equal(Gesture, e.GetProperty("modlistProgress").GetProperty("gesture").GetString()));
    }

    [Fact]
    public async Task RestoringAModWhoseRequestHandsNoInstallationFile_NamesEachItsManifestNames_SoARequestHandingThemBringsItBack()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        var response = await Client.PostAsJsonAsync("/restore-from-manifest", Request("restore-from-manifest", "Mod.zip", handsTheDownload: false));

        var skipped = Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refused").EnumerateArray());
        Assert.Equal("NotFound", skipped.GetProperty("refusal").GetString());
        Assert.Equal(["Mod.zip"], skipped.GetProperty("installationFilesNotFound").EnumerateArray().Select(name => name.GetString()));
    }

    [Fact]
    public async Task AModJustRestored_RestoreDestroysOnlyTheFilesNoLineNames()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        ChangedSinceItsUpdate();
        await Post("restore-from-manifest");

        var destroys = Assert.Single((await WhatRestoreDestroys()).EnumerateArray());

        Assert.Empty(Paths(destroys, "differing"));
        Assert.Equal(["untracked.txt"], Paths(destroys, "namedByNoLine"));
    }

    [Fact]
    public async Task AModWithAManifestLineItCannotRead_IsSkippedAsManifestUnreadable()
    {
        var torn = Path.Combine(_instance, "mods", "Torn");
        Directory.CreateDirectory(torn);
        File.WriteAllText(Path.Combine(torn, "Torn.manifest"), "<<<<<<< HEAD\n");
        var request = WhatRestoreDestroysRequest();
        request["mods"] = new JsonArray(new JsonObject { ["name"] = "Torn", ["folder"] = torn, ["committedFiles"] = new JsonArray() });

        var response = await Client.PostAsJsonAsync("/what-restore-destroys", request);

        var skipped = Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refused").EnumerateArray());
        Assert.Equal(("Torn", "ManifestUnreadable"), (skipped.GetProperty("item").GetString(), skipped.GetProperty("refusal").GetString()));
    }

    [PosixFact]
    public async Task AModWhoseManifestCannotBeRead_IsSkippedAsUnreadable_AndEveryOtherModIsListed()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        ChangedSinceItsUpdate();
        var locked = Path.Combine(_instance, "mods", "Locked");
        Directory.CreateDirectory(locked);
        File.WriteAllText(Path.Combine(locked, "Locked.manifest"), "");
        FileModes.Set(Path.Combine(locked, "Locked.manifest"), "000");
        var request = WhatRestoreDestroysRequest();
        Assert.IsType<JsonArray>(request["mods"]).Add(new JsonObject { ["name"] = "Locked", ["folder"] = locked, ["committedFiles"] = new JsonArray() });

        var response = await Client.PostAsJsonAsync("/what-restore-destroys", request);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(Mod, Assert.Single(body.GetProperty("mods").EnumerateArray()).GetProperty("mod").GetString());
        var skipped = Assert.Single(body.GetProperty("refused").EnumerateArray());
        Assert.Equal(("Locked", "Unreadable"), (skipped.GetProperty("item").GetString(), skipped.GetProperty("refusal").GetString()));
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

    [Theory]
    [InlineData("gameFiles")]
    [InlineData("dataFolder")]
    [InlineData("statCache")]
    [InlineData("excludedSuffix")]
    public async Task RestoringWithAFieldMissing_Is400(string field)
    {
        var request = Request("restore-from-manifest", "Mod.zip");
        request.Remove(field);

        var response = await Client.PostAsJsonAsync("/restore-from-manifest", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task RestoringNoMod_Is400()
    {
        var request = Request("restore-from-manifest", "Mod.zip");
        request["mods"] = new JsonArray();

        var response = await Client.PostAsJsonAsync("/restore-from-manifest", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("[{\"name\":\"RestoredMod\"}]")]
    public async Task AskingWhatRestoreDestroysInNoModOrAModWithNoFolder_Is400(string mods)
    {
        var request = WhatRestoreDestroysRequest();
        request["mods"] = JsonNode.Parse(mods);

        var response = await Client.PostAsJsonAsync("/what-restore-destroys", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task AskingWhatRestoreDestroysWithNoStatCache_Is400()
    {
        var request = WhatRestoreDestroysRequest();
        request.Remove("statCache");

        var response = await Client.PostAsJsonAsync("/what-restore-destroys", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
