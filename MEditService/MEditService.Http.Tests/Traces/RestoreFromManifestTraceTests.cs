using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Http.Tests.Traces;

public sealed class RestoreFromManifestTraceTests : HostedTests
{
    private const string Mod = "RestoredMod";
    private const string Gesture = "a-gesture";

    private readonly ScratchDirectory _instance = new("restore-from-manifest-");

    private string? _versionUpdated;

    protected override MEditHost CreateHost() => new(services => services.AddSingleton<TimeProvider>(new ADayAhead()));

    protected override void DisposeFixtures() => _instance.Dispose();

    private string ModFolder => Path.Combine(_instance, "mods", Mod);

    private string Downloads => Path.Combine(_instance, "downloads");

    private string StatCache => Path.Combine(_instance, "stat-cache");

    private string FileText(string path) => File.ReadAllText(Path.Combine(ModFolder, path));

    private void ModInstalledFromADownload()
    {
        DownloadedMod.Install(ModFolder, Downloads);
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "[General]");
    }

    private void ChangedSinceItsUpdate()
    {
        File.WriteAllText(Path.Combine(ModFolder, "edited.txt"), "edited");
        File.Delete(Path.Combine(ModFolder, "kept.txt"));
        File.WriteAllText(Path.Combine(ModFolder, "nonCompiledPlugin.txt"), "mine");
    }

    private JsonObject Request(string gesture, string downloadName, bool handsTheDownload = true, JsonObject? submodule = null, bool asksWhatItLacks = false)
    {
        var installationFile = new JsonObject
        {
            ["path"] = Path.Combine(Downloads, downloadName),
            ["size"] = 7,
            ["hash"] = DownloadedMod.HashOfTheZip,
            ["entries"] = new JsonArray(
                new JsonObject { ["path"] = "kept.txt", ["hash"] = DownloadedMod.HashOfKept }, new JsonObject { ["path"] = "edited.txt", ["hash"] = DownloadedMod.HashOfOriginal }),
        };
        var mod = new JsonObject
        {
            ["name"] = Mod,
            ["folder"] = ModFolder,
            ["installationFile"] = handsTheDownload ? installationFile : null,
            ["metadataFiles"] = new JsonArray("meta.ini"),
            ["version"] = _versionUpdated,
            ["submodule"] = submodule,
        };
        var request = new JsonObject
        {
            ["mods"] = new JsonArray(mod),
            ["statCache"] = StatCache,
            ["gesture"] = Gesture,
        };
        if (gesture == "restore-from-manifest")
        {
            request["exclusionMark"] = ".mohidden";
            request["asksWhatItLacks"] = asksWhatItLacks;
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
            ["metadataFiles"] = new JsonArray("meta.ini"),
            ["metadata"] = metadata,
            ["metadataUnreadable"] = metadataUnreadable,
        }),
        ["statCache"] = StatCache,
    };

    private static JsonObject Metadata(string? version) => new() { ["version"] = version };

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
        return Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray());
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
    public async Task AVersionTheManifestLacks_MakesAModDiffer_ButRestoreOverwritesNothing()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");

        var status = await ModStatus(WhatRestoreDestroysRequest(Metadata("2.0")));
        var destroys = await Client.PostAsJsonAsync("/what-restore-destroys", WhatRestoreDestroysRequest(Metadata("2.0")));

        Assert.True(status.GetProperty("metadataDiffers").GetBoolean());
        var listed = (await destroys.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("mods").EnumerateArray();
        Assert.Empty(listed);
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
    public async Task AModChangedSinceItsUpdate_ListsWhatRestoreDestroys_ButTheMetadataFiles()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        ChangedSinceItsUpdate();

        var destroys = Assert.Single((await WhatRestoreDestroys()).EnumerateArray());

        Assert.Equal(Mod, destroys.GetProperty("mod").GetString());
        Assert.Equal(["edited.txt"], Paths(destroys, "differing"));
        Assert.Equal(["nonCompiledPlugin.txt"], Paths(destroys, "namedByNoLine"));
    }

    [Fact]
    public async Task RestoringAModChangedSinceItsUpdate_BringsEveryFileBack_NamesEachFileNoLineNames_AndReportsItsProgressUnderItsGesture()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        ChangedSinceItsUpdate();
        using var stream = await Client.NotificationStream();

        var body = await Post("restore-from-manifest");

        var restored = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal(["edited.txt", "kept.txt"], Paths(restored, "written"));
        Assert.Equal(["nonCompiledPlugin.txt"], Paths(restored, "namedByNoLine"));
        Assert.Equal((DownloadedMod.Original, "kept"), (FileText("edited.txt"), FileText("kept.txt")));
        var progress = await stream.EventsUntil("restore-from-manifest-progress", e => e.GetProperty("modlistProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("modlistProgress").GetProperty("mod").GetString() == Mod);
        Assert.All(progress, e => Assert.Equal(Gesture, e.GetProperty("modlistProgress").GetProperty("gesture").GetString()));
    }

    [Theory]
    [InlineData(true, 0)]
    [InlineData(false, 1)]
    public async Task ARequestThatAsksWhatEachModLacks_LogsNoSkipForAModThatLacksAFile(bool asksWhatItLacks, int logged)
    {
        ModInstalledFromADownload();
        await Post("update-manifest");

        await Client.PostAsJsonAsync(
            "/restore-from-manifest", Request("restore-from-manifest", "Mod.zip", handsTheDownload: false, asksWhatItLacks: asksWhatItLacks));

        Assert.Equal(logged, Logged.Count(entry => entry.Message.StartsWith($"Refused Restore from manifest of {Mod}: NotFound", StringComparison.Ordinal)));
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
        Assert.Equal(["nonCompiledPlugin.txt"], Paths(destroys, "namedByNoLine"));
    }

    [Fact]
    public async Task AModWithAManifestLineItCannotRead_IsSkippedAsManifestUnreadable()
    {
        var torn = Path.Combine(_instance, "mods", "Torn");
        Directory.CreateDirectory(torn);
        File.WriteAllText(Path.Combine(torn, "Torn.manifest.json"), "<<<<<<< HEAD\n");
        var request = WhatRestoreDestroysRequest();
        request["mods"] = new JsonArray(new JsonObject { ["name"] = "Torn", ["folder"] = torn, ["metadataFiles"] = new JsonArray() });

        var response = await Client.PostAsJsonAsync("/what-restore-destroys", request);

        var skipped = Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refused").EnumerateArray());
        Assert.Equal(("Torn", "ManifestUnreadable"), (skipped.GetProperty("item").GetString(), skipped.GetProperty("refusal").GetString()));
        Assert.StartsWith("was skipped: its manifest cannot be read", skipped.GetProperty("message").GetString(), StringComparison.Ordinal);
    }

    [PosixFact]
    public async Task AModWhoseManifestCannotBeRead_IsSkippedAsUnreadable_AndEveryOtherModIsListed()
    {
        ModInstalledFromADownload();
        await Post("update-manifest");
        ChangedSinceItsUpdate();
        var locked = Path.Combine(_instance, "mods", "Locked");
        Directory.CreateDirectory(locked);
        File.WriteAllText(Path.Combine(locked, "Locked.manifest.json"), "");
        FileModes.Set(Path.Combine(locked, "Locked.manifest.json"), "000");
        var request = WhatRestoreDestroysRequest();
        Assert.IsType<JsonArray>(request["mods"]).Add(new JsonObject { ["name"] = "Locked", ["folder"] = locked, ["metadataFiles"] = new JsonArray() });

        var response = await Client.PostAsJsonAsync("/what-restore-destroys", request);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(Mod, Assert.Single(body.GetProperty("mods").EnumerateArray()).GetProperty("mod").GetString());
        var skipped = Assert.Single(body.GetProperty("refused").EnumerateArray());
        Assert.Equal(("Locked", "Unreadable"), (skipped.GetProperty("item").GetString(), skipped.GetProperty("refusal").GetString()));
    }

    private const string AMod = """ "name": "RestoredMod", "folder": "/mods/RestoredMod", "metadataFiles": ["meta.ini"] """;

    public static TheoryData<string, string> NotARequestToRestore => new()
    {
        { "no mod", """{"mods": [], "statCache": "/cache", "exclusionMark": ".mohidden"}""" },
        { "no stat cache", $$"""{"mods": [{ {{AMod}} }], "exclusionMark": ".mohidden"}""" },
        { "no exclusion mark", $$"""{"mods": [{ {{AMod}} }], "statCache": "/cache"}""" },
        { "a submodule with no folder", $$"""{"mods": [{ {{AMod}}, "submodule": {"pin": "0123abc"} }], "statCache": "/cache", "exclusionMark": ".mohidden"}""" },
        { "a submodule with no pin", $$"""{"mods": [{ {{AMod}}, "submodule": {"folder": "/source/Mod"} }], "statCache": "/cache", "exclusionMark": ".mohidden"}""" },
        { "a game folder with no name", $$"""{"mods": [{ {{AMod}} }], "statCache": "/cache", "exclusionMark": ".mohidden", "gameFolder": {"dataFolder": "/Data", "files": []} }""" },
        { "a game folder with no data folder", $$"""{"mods": [{ {{AMod}} }], "statCache": "/cache", "exclusionMark": ".mohidden", "gameFolder": {"name": "Fallout4", "files": []} }""" },
        { "a game folder with no files", $$"""{"mods": [{ {{AMod}} }], "statCache": "/cache", "exclusionMark": ".mohidden", "gameFolder": {"name": "Fallout4", "dataFolder": "/Data"} }""" },
    };

    [Theory]
    [MemberData(nameof(NotARequestToRestore))]
    public async Task ARequestThatDoesNotSayWhatToRestore_Is400(string lacking, string body)
    {
        var response = await Client.PostJson("/restore-from-manifest", body);

        Assert.True(response.StatusCode == HttpStatusCode.BadRequest, lacking);
    }

    public static TheoryData<string, string, string> NotAQuestionOfModFolders => new()
    {
        { "/what-restore-destroys", "no mod", """{"mods": [], "statCache": "/cache"}""" },
        { "/what-restore-destroys", "a mod with no folder", """{"mods": [{"name": "RestoredMod"}], "statCache": "/cache"}""" },
        { "/what-restore-destroys", "no stat cache", $$"""{"mods": [{ {{AMod}} }]}""" },
        { "/mod-status", "no mod", """{"mods": [], "statCache": "/cache"}""" },
        {
            "/mod-status", "a mod handed both its metadata and why it could not be read",
            $$"""{"mods": [{ {{AMod}}, "metadata": {"version": "2.0"}, "metadataUnreadable": "access denied"}], "statCache": "/cache"}"""
        },
    };

    [Theory]
    [MemberData(nameof(NotAQuestionOfModFolders))]
    public async Task AQuestionThatDoesNotNameEachModsFolder_Is400(string route, string lacking, string body)
    {
        var response = await Client.PostJson(route, body);

        Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{route}: {lacking}");
    }
}
