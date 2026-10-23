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

    private Dictionary<string, object> Body() => SnapshotPlugins.Body(_fixture.DataFolder, _fixture.InstanceRoot, _fixture.Plugins);

    [Fact]
    public async Task PutLoadOrder_TheArchivesAndStringsFilesItNames_AreTheOnesTheLoadOrderHolds()
    {
        StampedFile[] archives = [new(Path.Combine(_fixture.DataFolder, "Fallout4 - Interface.ba2"), "1/2/3"), new(Path.Combine(_fixture.DataFolder, "A - Main.ba2"), "4/5/6")];
        StampedFile[] stringsFiles = [new(Path.Combine(_fixture.DataFolder, "Strings", "A_en.STRINGS"), "7/8/9")];
        var body = Body();
        body["archives"] = archives;
        body["stringsFiles"] = stringsFiles;

        var response = await _client.PutLoadOrderAndAwaitReady(body);

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
        var body = Body();
        body["plugins"] = _fixture.Plugins.Skip(1).Prepend(handed).Select(p => p.Wire);

        var response = await _client.PutLoadOrderAndAwaitReady(body);

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
    [InlineData("gameRelease")]
    public async Task PutLoadOrder_WithAFieldItNeverDefaultsLeftOut_Returns400(string omitted)
    {
        var body = Body();
        body.Remove(omitted);

        var response = await _client.PutAsJsonAsync("/load-order", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("99")]
    [InlineData("Klingon")]
    public async Task PutLoadOrder_WithAStringsLanguageNoGameHas_Returns400(string stringsLanguage)
    {
        var body = Body();
        body["stringsLanguage"] = stringsLanguage;

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
        var body = Body();
        body["plugins"] = _fixture.Plugins.Select(p => new
        {
            p.Name,
            p.Path,
            p.Origin,
            Provider = new { Kind = kind, Mod = mod, Folder = folder, SourceFolder = sourceFolder },
            p.Strings.Archives,
            p.Strings.StringsFiles,
        });

        var response = await _client.PutAsJsonAsync("/load-order", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_AModThatIsNoSourceMod_HasNoSourceFolder_Returns200()
    {
        var body = Body();
        body["plugins"] = _fixture.Plugins.Select(p => new
        {
            p.Name,
            p.Path,
            p.Origin,
            Provider = new { Kind = "Mod", Mod = p.Origin, Folder = Path.GetDirectoryName(p.Path) },
            p.Strings.Archives,
            p.Strings.StringsFiles,
        });

        var response = await _client.PutLoadOrderAndAwaitReady(body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_APluginWithNoProvider_Returns400()
    {
        var body = Body();
        body["plugins"] = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Strings.Archives, p.Strings.StringsFiles });

        var response = await _client.PutAsJsonAsync("/load-order", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("archives")]
    [InlineData("stringsFiles")]
    public async Task PutLoadOrder_APluginWithAListItNeverDefaultsLeftOut_Returns400(string omitted)
    {
        var body = Body();
        body["plugins"] = _fixture.Plugins.Select(p => new Dictionary<string, object>
        {
            ["name"] = p.Name,
            ["path"] = p.Path,
            ["origin"] = p.Origin,
            ["provider"] = new { Kind = "Game" },
            ["archives"] = p.Strings.Archives,
            ["stringsFiles"] = p.Strings.StringsFiles,
        }.Where(field => field.Key != omitted).ToDictionary());
        body["active"] = Array.Empty<object>();
        body["loadedWithNoLine"] = Array.Empty<object>();

        var response = await _client.PutAsJsonAsync("/load-order", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_APluginsStringsFileWithNoStamp_Returns400()
    {
        var body = Body();
        body["plugins"] = _fixture.Plugins.Select(p => new
        {
            p.Name,
            p.Path,
            p.Origin,
            Provider = new { Kind = "Game" },
            Archives = Array.Empty<object>(),
            StringsFiles = new[] { new { Path = Path.Combine(_fixture.DataFolder, "Strings", "A_en.STRINGS") } },
        });
        body["active"] = Array.Empty<object>();
        body["loadedWithNoLine"] = Array.Empty<object>();

        var response = await _client.PutAsJsonAsync("/load-order", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_TwoActivePluginsOfOneFilename_Returns400()
    {
        var plugin = _fixture.Plugins[0];
        var body = Body();
        body["plugins"] = new[] { plugin.Wire, (plugin with { Origin = "OtherMod" }).Wire };
        body["active"] = new[] { new { name = plugin.Name, origin = plugin.Origin }, new { name = plugin.Name, origin = "OtherMod" } };
        body["loadedWithNoLine"] = Array.Empty<object>();

        var response = await _client.PutAsJsonAsync("/load-order", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("OtherMod", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task PutLoadOrder_MissingDataFolder_Returns400()
    {
        var body = Body();
        body["dataFolder"] = "/no-such-dir";

        var response = await _client.PutAsJsonAsync("/load-order", body);

        Assert.Equal("DataFolderNotFound", (await response.AssertIsProblem(HttpStatusCode.BadRequest)).GetProperty("refusal").GetString());
    }
}
