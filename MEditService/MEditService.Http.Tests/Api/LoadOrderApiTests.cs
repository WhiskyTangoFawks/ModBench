using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.Http.Tests.Api;

public sealed class LoadOrderApiTests : HostedTests
{
    private readonly TestPluginFixture _fixture;

    public LoadOrderApiTests() => _fixture = Owned(TestPluginFixture.Create());

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

        var response = await Client.PutAsJsonAsync("/load-order", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("99")]
    [InlineData("Klingon")]
    public async Task PutLoadOrder_WithAStringsLanguageNoGameHas_Returns400(string stringsLanguage)
    {
        var body = Body();
        body["stringsLanguage"] = stringsLanguage;

        var response = await Client.PutAsJsonAsync("/load-order", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_AnUnknownGameRelease_Is400()
    {
        var body = Body();
        body["gameRelease"] = "NotAGame";

        var response = await Client.PutAsJsonAsync("/load-order", body);

        await response.AssertIsProblem(HttpStatusCode.BadRequest);
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

        var response = await Client.PutAsJsonAsync("/load-order", body);

        Assert.Equal((lacking, HttpStatusCode.BadRequest), (lacking, response.StatusCode));
    }

    [Fact]
    public async Task PutLoadOrder_TwoActivePluginsOfOneFilename_Returns400()
    {
        var plugin = _fixture.Plugins[0];
        var body = Body();
        body["plugins"] = new[] { plugin.Wire, (plugin with { Origin = "OtherMod" }).Wire };
        body["active"] = new[] { new { name = plugin.Name, origin = plugin.Origin }, new { name = plugin.Name, origin = "OtherMod" } };
        body["loadedWithNoLine"] = Array.Empty<object>();

        var response = await Client.PutAsJsonAsync("/load-order", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("OtherMod", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task PutLoadOrder_MissingDataFolder_Returns400()
    {
        var body = Body();
        body["dataFolder"] = "/no-such-dir";

        var response = await Client.PutAsJsonAsync("/load-order", body);

        Assert.Equal("DataFolderNotFound", (await response.AssertIsProblem(HttpStatusCode.BadRequest)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task PutLoadOrder_AModsPluginNamingNoSourceFolder_IsAccepted()
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

        var response = await Client.PutLoadOrderAndAwaitReady(body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_APluginTheSnapshotDoesNotListAsActive_ComesBackOutsideTheLoadOrder()
    {
        var fx = Owned(new PluginFixtureBuilder("api-reconcile-disabled")
            .WithPlugin("Active.esp", mod => mod.Npcs.AddNew("FromActive"))
            .WithPlugin("Dormant.esp", mod => mod.Npcs.AddNew("FromDormant"), enabled: false)
            .BuildScattered());

        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        Assert.False((await Client.Plugin("Dormant.esp")).GetProperty("inLoadOrder").GetBoolean());
    }

    [Fact]
    public async Task PutLoadOrder_TheGamesStringsFilesItNames_AreWhereALocalizedPluginsNamesAreRead()
    {
        var fx = Owned(new PluginFixtureBuilder("api-games-strings")
            .WithPlugin("Localized.esp", mod =>
            {
                mod.UsingLocalization = true;
                mod.Activators.AddNew("LocalizedLever").Name = new TranslatedString(
                    Language.English,
                    new KeyValuePair<Language, string>(Language.French, "Levier"),
                    new KeyValuePair<Language, string>(Language.English, "Lever"));
            }, origin: "LocalizedMod")
            .BuildScattered());
        var plugin = fx.Plugins.Single();
        var body = SnapshotPlugins.Body(fx.DataFolder, fx.InstanceRoot, [plugin with { NamedStrings = new PluginStrings([], []) }], stringsLanguage: "French");
        body["stringsFiles"] = plugin.Strings.StringsFiles;

        (await Client.PutLoadOrderAndAwaitReady(body)).EnsureSuccessStatusCode();

        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Localized.esp&origin=LocalizedMod&type=acti&limit=10");
        Assert.Equal("Levier", activators.GetProperty("items")[0].GetProperty("fullName").GetString());
    }
}
