using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Http.Tests.Traces;

public sealed class UpdateManifestTraceTests : HostedTests
{
    private const string Mod = "UpdatedMod";
    private const string Gesture = "a-gesture";

    private readonly ScratchDirectory _instance = new("trace-update-manifest-");

    protected override MEditHost CreateHost() => new(services => services.AddSingleton<TimeProvider>(new ADayAhead()));

    protected override void DisposeFixtures() => _instance.Dispose();

    private string ModFolder => Path.Combine(_instance, "mods", Mod);

    private string Downloads => Path.Combine(_instance, "downloads");

    private void ModInstalledFromADownload(bool edited) => DownloadedMod.Install(ModFolder, Downloads, edited ? "edited" : null);

    private Task<HttpResponseMessage> UpdateManifest(string downloadName) => Client.PostAsJsonAsync("/update-manifest", new
    {
        mods = new[]
        {
            new
            {
                name = Mod,
                folder = ModFolder,
                version = "1.2.3",
                installationFile = new
                {
                    path = Path.Combine(Downloads, downloadName),
                    page = "https://www.nexusmods.com/fallout4/mods/1",
                    size = 7,
                    hash = DownloadedMod.HashOfTheZip,
                    entries = new[] { new { path = "kept.txt", hash = DownloadedMod.HashOfKept }, new { path = "edited.txt", hash = DownloadedMod.HashOfOriginal } },
                },
            },
        },
        statCache = Path.Combine(_instance, "stat-cache"),
        gesture = Gesture,
    });

    private const string AMod = """ "name": "UpdatedMod", "folder": "/mods/UpdatedMod" """;
    private const string AnEntry = """{"path": "kept.txt", "hash": "gO3vE0ddOto="}""";
    private const string AGameFile = """{"path": "Data/A.nif", "hash": "E46vZ8f023k="}""";

    public static TheoryData<string, string> NotARequestToUpdate => new()
    {
        { "no mod", """{"mods": [], "statCache": "/cache"}""" },
        { "no stat cache", $$"""{"mods": [{ {{AMod}}, "installationFile": {"path": "/d/Mod.zip", "size": 7, "hash": "AAECAwQFBgc=", "entries": [{{AnEntry}}]} }]}""" },
        { "a download with no size", $$"""{"mods": [{ {{AMod}}, "installationFile": {"path": "/d/Mod.zip", "hash": "AAECAwQFBgc=", "entries": [{{AnEntry}}]} }], "statCache": "/cache"}""" },
        { "a download with no hash", $$"""{"mods": [{ {{AMod}}, "installationFile": {"path": "/d/Mod.zip", "size": 7, "entries": [{{AnEntry}}]} }], "statCache": "/cache"}""" },
        { "a download whose hash is no hash", $$"""{"mods": [{ {{AMod}}, "installationFile": {"path": "/d/Mod.zip", "size": 7, "hash": "WHOLE", "entries": [{{AnEntry}}]} }], "statCache": "/cache"}""" },
        { "a download with no entries", $$"""{"mods": [{ {{AMod}}, "installationFile": {"path": "/d/Mod.zip", "size": 7, "hash": "AAECAwQFBgc="} }], "statCache": "/cache"}""" },
        { "an entry whose hash is no hash", $$"""{"mods": [{ {{AMod}}, "installationFile": {"path": "/d/Mod.zip", "size": 7, "hash": "AAECAwQFBgc=", "entries": [{"path": "kept.txt", "hash": "WHOLE"}]} }], "statCache": "/cache"}""" },
        { "a downloaded file with no size", $$"""{"mods": [{ {{AMod}}, "metadataFiles": [] }], "statCache": "/cache", "downloadedFiles": [{"path": "/d/Mod.zip", "hash": "AAECAwQFBgc=", "entries": [{{AnEntry}}]}]}""" },
        { "a downloaded file whose entry hash is no hash", $$"""{"mods": [{ {{AMod}}, "metadataFiles": [] }], "statCache": "/cache", "downloadedFiles": [{"path": "/d/Mod.zip", "size": 7, "hash": "AAECAwQFBgc=", "entries": [{"path": "kept.txt", "hash": "WHOLE"}]}]}""" },
        { "a game folder with no name", $$"""{"mods": [{ {{AMod}}, "metadataFiles": [], "gameFolder": {"root": "/game", "files": [{{AGameFile}}]} }], "statCache": "/cache"}""" },
        { "a game folder with no root", $$"""{"mods": [{ {{AMod}}, "metadataFiles": [], "gameFolder": {"name": "Fallout4", "files": [{{AGameFile}}]} }], "statCache": "/cache"}""" },
        { "a game folder with no files", $$"""{"mods": [{ {{AMod}}, "metadataFiles": [], "gameFolder": {"name": "Fallout4", "root": "/game"} }], "statCache": "/cache"}""" },
        { "an elsewhere place with no root", $$"""{"mods": [{ {{AMod}}, "metadataFiles": [], "gameFolder": {"name": "Fallout4", "root": "/game", "files": [], "elsewhere": [{"files": [{{AGameFile}}]}]} }], "statCache": "/cache"}""" },
        { "an elsewhere place with no files", $$"""{"mods": [{ {{AMod}}, "metadataFiles": [], "gameFolder": {"name": "Fallout4", "root": "/game", "files": [], "elsewhere": [{"root": "/steam"}]} }], "statCache": "/cache"}""" },
        { "an elsewhere game file whose hash is no hash", $$"""{"mods": [{ {{AMod}}, "metadataFiles": [], "gameFolder": {"name": "Fallout4", "root": "/game", "files": [], "elsewhere": [{"root": "/steam", "files": [{"path": "Data/A.nif", "hash": "WHOLE"}]}]} }], "statCache": "/cache"}""" },
        { "a depot with no version", $$"""{"mods": [{ {{AMod}}, "metadataFiles": [], "gameFolder": {"name": "Fallout4", "root": "/game", "files": [], "depots": [{"id": "377162"}]} }], "statCache": "/cache"}""" },
        { "an elsewhere depot with no id", $$"""{"mods": [{ {{AMod}}, "metadataFiles": [], "gameFolder": {"name": "Fallout4", "root": "/game", "files": [], "elsewhere": [{"root": "/steam", "files": [], "depots": [{"version": "1"}]}]} }], "statCache": "/cache"}""" },
        { "a game file whose hash is no hash", $$"""{"mods": [{ {{AMod}}, "metadataFiles": [], "gameFolder": {"name": "Fallout4", "root": "/game", "files": [{"path": "Data/A.nif", "hash": "WHOLE"}]} }], "statCache": "/cache"}""" },
    };

    [Theory]
    [MemberData(nameof(NotARequestToUpdate))]
    public async Task ARequestThatDoesNotSayWhatToUpdate_Is400(string lacking, string body)
    {
        var response = await Client.PostJson("/update-manifest", body);

        Assert.Equal((lacking, HttpStatusCode.BadRequest), (lacking, response.StatusCode));
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
        Assert.Empty(updated.GetProperty("notInPackage").EnumerateArray());
        Assert.Equal(["edited.txt"], updated.GetProperty("otherBytes").EnumerateArray().Select(path => path.GetString()));
        Assert.Empty(body.GetProperty("refused").EnumerateArray());
        Assert.Equal(
            "{\n"
            + $"\"packages\": [\n{{\"installationFile\":\"Mod.zip\",\"size\":7,\"hash\":\"{DownloadedMod.HashOfTheZip}\",\"page\":\"https://www.nexusmods.com/fallout4/mods/1\",\"version\":\"1.2.3\"}}\n],\n"
            + "\"files\": [\n"
            + "{\"path\":\"edited.txt\",\"otherBytes\":true},\n"
            + "{\"path\":\"kept.txt\"}\n"
            + "]\n"
            + "}\n",
            File.ReadAllText(Path.Combine(ModFolder, Mod + ".manifest.json")));
        var progress = await stream.EventsUntil("update-manifest-progress", e => e.GetProperty("modlistProgress").GetProperty("mod").ValueKind == JsonValueKind.Null);
        Assert.Contains(progress, e => e.GetProperty("modlistProgress").GetProperty("mod").GetString() == Mod);
        Assert.All(progress, e => Assert.Equal(Gesture, e.GetProperty("modlistProgress").GetProperty("gesture").GetString()));
    }

    [Fact]
    public async Task UpdatingTheManifestOfAModWhoseFilesTheGameFolderHolds_NamesTheGameFolderAsItsPackage()
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "a.nif"), "taken");

        var response = await Client.PostAsJsonAsync("/update-manifest", new
        {
            mods = new[]
            {
                new
                {
                    name = Mod, folder = ModFolder, metadataFiles = Array.Empty<string>(),
                    gameFolder = new
                    {
                        name = "Fallout4",
                        root = Path.Combine(_instance, "game"),
                        files = new[] { new { path = "Data/A.nif", hash = "E46vZ8f023k=", pathInFolder = "a.nif" } },
                    },
                },
            },
            statCache = Path.Combine(_instance, "stat-cache"),
        });

        response.EnsureSuccessStatusCode();
        Assert.Equal(
            "{\n\"packages\": [\n{\"gameFolder\":\"Fallout4\",\"hash\":\"o3vrBOqOSww=\"}\n],\n\"files\": [\n{\"path\":\"a.nif\",\"packagePath\":\"Data/A.nif\"}\n]\n}\n",
            File.ReadAllText(Path.Combine(ModFolder, Mod + ".manifest.json")));
    }

    [Fact]
    public async Task UpdatingTheManifestOfAModTakenFromTheGameFoldersDepots_NamesEachDepotAndItsVersion()
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "a.nif"), "taken");

        var response = await Client.PostAsJsonAsync("/update-manifest", new
        {
            mods = new[]
            {
                new
                {
                    name = Mod, folder = ModFolder, metadataFiles = Array.Empty<string>(),
                    gameFolder = new
                    {
                        name = "Fallout4",
                        root = Path.Combine(_instance, "game"),
                        files = new[] { new { path = "Data/A.nif", hash = "E46vZ8f023k=", pathInFolder = "a.nif" } },
                        depots = new[] { new { id = "377162", version = "22" } },
                    },
                },
            },
            statCache = Path.Combine(_instance, "stat-cache"),
        });

        response.EnsureSuccessStatusCode();
        Assert.Contains("\"depots\":{\"377162\":\"22\"}", File.ReadAllText(Path.Combine(ModFolder, Mod + ".manifest.json")));
    }

    [Fact]
    public async Task UpdatingTheManifestOfAModWithNoInstallationFile_NamesADownloadedFileTheRequestHandsAsAPackage()
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "a.nif"), "taken");

        var response = await Client.PostAsJsonAsync("/update-manifest", new
        {
            mods = new[] { new { name = Mod, folder = ModFolder, metadataFiles = Array.Empty<string>() } },
            statCache = Path.Combine(_instance, "stat-cache"),
            downloadedFiles = new[]
            {
                new
                {
                    path = Path.Combine(Downloads, "Other.zip"), size = 7, hash = DownloadedMod.HashOfTheZip,
                    entries = new[] { new { path = "Data/A.nif", hash = "E46vZ8f023k=" } },
                },
            },
        });

        response.EnsureSuccessStatusCode();
        Assert.Contains("\"installationFile\":\"Other.zip\"", File.ReadAllText(Path.Combine(ModFolder, Mod + ".manifest.json")));
    }

    [Fact]
    public async Task UpdatingTheManifestOfAModWhoseFilesAnotherPlaceHolds_NamesTheGameFolderAsItsPackage()
    {
        Directory.CreateDirectory(ModFolder);
        File.WriteAllText(Path.Combine(ModFolder, "a.nif"), "taken");

        var response = await Client.PostAsJsonAsync("/update-manifest", new
        {
            mods = new[]
            {
                new
                {
                    name = Mod, folder = ModFolder, metadataFiles = Array.Empty<string>(),
                    gameFolder = new
                    {
                        name = "Fallout4",
                        root = Path.Combine(_instance, "game"),
                        files = Array.Empty<object>(),
                        elsewhere = new[]
                        {
                            new { root = Path.Combine(_instance, "steam"), files = new[] { new { path = "Data/A.nif", hash = "E46vZ8f023k=", pathInFolder = "a.nif" } } },
                        },
                    },
                },
            },
            statCache = Path.Combine(_instance, "stat-cache"),
        });

        response.EnsureSuccessStatusCode();
        Assert.Contains("\"gameFolder\":\"Fallout4\"", File.ReadAllText(Path.Combine(ModFolder, Mod + ".manifest.json")));
    }
}
