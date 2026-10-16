using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class LoadOrderApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private readonly TestPluginFixture _fixture = loaded.Plugin;

    [Fact]
    public async Task PutLoadOrder_ScatteredPaths_Returns200AndLoadsPlugins()
    {
        using var fx = new PluginFixtureBuilder("api-explicit")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        var response = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(fx.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(fx.Plugins),
            archives = Array.Empty<string>(),
            stringsFiles = Array.Empty<string>(),
            mods = Array.Empty<object>(),
            places = Array.Empty<object>(),
            statCache = "stat-cache",
            gameRelease = "Fallout4",
            stringsLanguage = "English",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var plugins = await _client.GetFromJsonAsync<List<dynamic>>("/plugins");
        Assert.NotNull(plugins);
        Assert.Equal(2, plugins.Count);
    }

    [Fact]
    public async Task PutLoadOrder_TheArchivesAndStringsFilesItNames_AreTheOnesTheLoadOrderHolds()
    {
        StampedFile[] archives = [new(Path.Combine(_fixture.DataFolder, "Fallout4 - Interface.ba2"), "1/2/3"), new(Path.Combine(_fixture.DataFolder, "A - Main.ba2"), "4/5/6")];
        StampedFile[] stringsFiles = [new(Path.Combine(_fixture.DataFolder, "Strings", "A_en.STRINGS"), "7/8/9")];

        var response = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            archives,
            stringsFiles,
            mods = Array.Empty<object>(),
            places = Array.Empty<object>(),
            statCache = "stat-cache",
            gameRelease = "Fallout4",
            stringsLanguage = "English",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var held = loaded.Services.GetRequiredService<LoadOrderHolder>().Require();
        Assert.Equal<IEnumerable<StampedFile>>([archives, stringsFiles], [held.Archives, held.StringsFiles]);
    }

    [Fact]
    public async Task PutLoadOrder_ThePluginsOwnArchivesAndStringsFiles_AreTheOnesItsCopyHolds()
    {
        var handed = _fixture.Plugins[0] with
        {
            NamedStrings = new(
                [new StampedFile(Path.Combine(_fixture.DataFolder, "A - Main.ba2"), "1/2")],
                [new StampedFile(Path.Combine(_fixture.DataFolder, "Strings", "A_en.STRINGS"), "3/4")]),
        };

        var response = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Skip(1).Prepend(handed).Select(p => p.Wire),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            archives = Array.Empty<string>(),
            stringsFiles = Array.Empty<string>(),
            mods = Array.Empty<object>(),
            places = Array.Empty<object>(),
            statCache = "stat-cache",
            gameRelease = "Fallout4",
            stringsLanguage = "English",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(handed.Strings, loaded.Services.GetRequiredService<LoadOrderHolder>().Require().Plugin(handed.Key)?.Strings);
    }

    [Theory]
    [InlineData("active")]
    [InlineData("loadedWithNoLine")]
    [InlineData("archives")]
    [InlineData("stringsFiles")]
    [InlineData("places")]
    [InlineData("mods")]
    [InlineData("statCache")]
    [InlineData("stringsLanguage")]
    public async Task PutLoadOrder_WithAListItNeverDefaultsLeftOut_Returns400(string omitted)
    {
        var body = new Dictionary<string, object>
        {
            ["gameDirectory"] = _fixture.DataFolder,
            ["instanceRoot"] = _fixture.InstanceRoot,
            ["plugins"] = _fixture.Plugins.Select(p => p.Wire),
            ["active"] = SnapshotPlugins.Active(_fixture.Plugins),
            ["loadedWithNoLine"] = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            ["archives"] = Array.Empty<string>(),
            ["stringsFiles"] = Array.Empty<string>(),
            ["places"] = Array.Empty<object>(),
            ["mods"] = Array.Empty<object>(),
            ["statCache"] = "stat-cache",
            ["gameRelease"] = "Fallout4",
            ["stringsLanguage"] = "English",
        };
        body.Remove(omitted);

        var response = await _client.PutAsJsonAsync("/load-order", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("Game", "ModA", null, null)]
    [InlineData("None", null, "/mods/ModA", null)]
    [InlineData("Game", null, null, "/source/ModA")]
    [InlineData("Mod", "ModA", null, "/source/ModA")]
    [InlineData("Mod", null, "/mods/ModA", "/source/ModA")]
    [InlineData("Mod", "ModA", "/mods/ModA", "")]
    public async Task PutLoadOrder_AProviderWhoseModAndFoldersDisagreeWithItsKind_Returns400(string kind, string? mod, string? folder, string? sourceFolder)
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => new
            {
                p.Name,
                p.Path,
                p.Origin,
                Provider = new { Kind = kind, Mod = mod, Folder = folder, SourceFolder = sourceFolder },
                p.Strings.Archives,
                p.Strings.StringsFiles,
            }),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            archives = Array.Empty<string>(),
            stringsFiles = Array.Empty<string>(),
            mods = Array.Empty<object>(),
            places = Array.Empty<object>(),
            statCache = "stat-cache",
            gameRelease = "Fallout4",
            stringsLanguage = "English",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_AModThatIsNoSourceMod_HasNoSourceFolder_Returns200()
    {
        var response = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => new
            {
                p.Name,
                p.Path,
                p.Origin,
                Provider = new { Kind = "Mod", Mod = p.Origin, Folder = Path.GetDirectoryName(p.Path) },
                p.Strings.Archives,
                p.Strings.StringsFiles,
            }),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            archives = Array.Empty<string>(),
            stringsFiles = Array.Empty<string>(),
            mods = Array.Empty<object>(),
            places = Array.Empty<object>(),
            statCache = "stat-cache",
            gameRelease = "Fallout4",
            stringsLanguage = "English",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_APluginWithNoProvider_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Strings.Archives, p.Strings.StringsFiles }),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            archives = Array.Empty<string>(),
            stringsFiles = Array.Empty<string>(),
            mods = Array.Empty<object>(),
            places = Array.Empty<object>(),
            statCache = "stat-cache",
            gameRelease = "Fallout4",
            stringsLanguage = "English",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("archives")]
    [InlineData("stringsFiles")]
    public async Task PutLoadOrder_APluginWithAListItNeverDefaultsLeftOut_Returns400(string omitted)
    {
        var plugins = _fixture.Plugins.Select(p => new Dictionary<string, object>
        {
            ["name"] = p.Name,
            ["path"] = p.Path,
            ["origin"] = p.Origin,
            ["provider"] = new { Kind = "Game" },
            ["archives"] = p.Strings.Archives,
            ["stringsFiles"] = p.Strings.StringsFiles,
        }.Where(field => field.Key != omitted).ToDictionary());

        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins,
            active = Array.Empty<object>(),
            loadedWithNoLine = Array.Empty<object>(),
            archives = Array.Empty<string>(),
            stringsFiles = Array.Empty<string>(),
            mods = Array.Empty<object>(),
            places = Array.Empty<object>(),
            statCache = "stat-cache",
            gameRelease = "Fallout4",
            stringsLanguage = "English",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_APluginsStringsFileWithNoStamp_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => new
            {
                p.Name,
                p.Path,
                p.Origin,
                Provider = new { Kind = "Game" },
                Archives = Array.Empty<object>(),
                StringsFiles = new[] { new { Path = Path.Combine(_fixture.DataFolder, "Strings", "A_en.STRINGS") } },
            }),
            active = Array.Empty<object>(),
            loadedWithNoLine = Array.Empty<object>(),
            archives = Array.Empty<string>(),
            stringsFiles = Array.Empty<string>(),
            mods = Array.Empty<object>(),
            places = Array.Empty<object>(),
            statCache = "stat-cache",
            gameRelease = "Fallout4",
            stringsLanguage = "English",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_WithNoGameRelease_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            archives = Array.Empty<string>(),
            stringsFiles = Array.Empty<string>(),
            mods = Array.Empty<object>(),
            places = Array.Empty<object>(),
            statCache = "stat-cache",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_TwoActivePluginsOfOneFilename_Returns400()
    {
        var plugin = _fixture.Plugins[0];
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = new[] { plugin.Wire, (plugin with { Origin = "OtherMod" }).Wire },
            active = new[] { new { name = plugin.Name, origin = plugin.Origin }, new { name = plugin.Name, origin = "OtherMod" } },
            loadedWithNoLine = Array.Empty<object>(),
            archives = Array.Empty<string>(),
            stringsFiles = Array.Empty<string>(),
            mods = Array.Empty<object>(),
            places = Array.Empty<object>(),
            statCache = "stat-cache",
            gameRelease = "Fallout4",
            stringsLanguage = "English",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("OtherMod", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task PutLoadOrder_MissingGameDirectory_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = "/no-such-dir",
            instanceRoot = _fixture.InstanceRoot,
            plugins = Array.Empty<object>(),
            gameRelease = "Fallout4",
            stringsLanguage = "English",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_MissingInstanceRoot_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = "/no-such-instance",
            plugins = Array.Empty<object>(),
            gameRelease = "Fallout4",
            stringsLanguage = "English",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
