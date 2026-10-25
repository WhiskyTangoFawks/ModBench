using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class LoadOrderApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private readonly TestPluginFixture _fixture = loaded.Plugin;

    private Dictionary<string, object> Body() => SnapshotPlugins.Body(_fixture.DataFolder, _fixture.InstanceRoot, _fixture.Plugins);

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

    private const string Named = """ "name": "Any.esp", "path": "/data/Any.esp", "origin": "AnyMod" """;

    public static TheoryData<string, string> NotAPluginEntry => new()
    {
        { "a game plugin naming a mod", $$"""{ {{Named}}, "provider": {"kind": "Game", "mod": "ModA"}, "archives": [], "stringsFiles": [] }""" },
        { "a plugin of no mod naming a folder", $$"""{ {{Named}}, "provider": {"kind": "None", "folder": "/mods/ModA"}, "archives": [], "stringsFiles": [] }""" },
        { "a game plugin naming a source folder", $$"""{ {{Named}}, "provider": {"kind": "Game", "sourceFolder": "/source/ModA"}, "archives": [], "stringsFiles": [] }""" },
        { "a mod's plugin naming no folder", $$"""{ {{Named}}, "provider": {"kind": "Mod", "mod": "ModA", "sourceFolder": "/source/ModA"}, "archives": [], "stringsFiles": [] }""" },
        { "a mod's plugin naming no mod", $$"""{ {{Named}}, "provider": {"kind": "Mod", "folder": "/mods/ModA", "sourceFolder": "/source/ModA"}, "archives": [], "stringsFiles": [] }""" },
        { "a mod's plugin naming an empty source folder", $$"""{ {{Named}}, "provider": {"kind": "Mod", "mod": "ModA", "folder": "/mods/ModA", "sourceFolder": ""}, "archives": [], "stringsFiles": [] }""" },
        { "no provider", $$"""{ {{Named}}, "archives": [], "stringsFiles": [] }""" },
        { "no archives", $$"""{ {{Named}}, "provider": {"kind": "Game"}, "stringsFiles": [] }""" },
        { "no strings files", $$"""{ {{Named}}, "provider": {"kind": "Game"}, "archives": [] }""" },
        { "a strings file with no stamp", $$"""{ {{Named}}, "provider": {"kind": "Game"}, "archives": [], "stringsFiles": [{"path": "/data/Strings/A_en.STRINGS"}] }""" },
    };

    [Theory]
    [MemberData(nameof(NotAPluginEntry))]
    public async Task PutLoadOrder_APluginEntryLackingWhatMakesItAPlugin_Returns400(string lacking, string entry)
    {
        var body = Body();
        body["plugins"] = new[] { JsonDocument.Parse(entry).RootElement };
        body["active"] = Array.Empty<object>();
        body["loadedWithNoLine"] = Array.Empty<object>();

        var response = await _client.PutAsJsonAsync("/load-order", body);

        Assert.True(response.StatusCode == HttpStatusCode.BadRequest, lacking);
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
