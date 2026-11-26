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

    private ScatteredFixtureData ALocalizedPlugin() =>
        Owned(new PluginFixtureBuilder("api-localized-strings")
            .WithPlugin("Localized.esp", mod =>
            {
                mod.UsingLocalization = true;
                mod.Activators.AddNew("LocalizedLever").Name = new TranslatedString(
                    Language.English,
                    new KeyValuePair<Language, string>(Language.French, "Levier"),
                    new KeyValuePair<Language, string>(Language.English, "Lever"));
            }, origin: "LocalizedMod")
            .BuildScattered());

    private async Task<string?> TheLocalizedNameReadInFrench(
        ScatteredFixtureData fx, LoadOrderEntry plugin, StampedFile[] gameArchives, StampedFile[] gameStringsFiles)
    {
        var body = SnapshotPlugins.Body(fx.DataFolder, fx.InstanceRoot, [plugin], stringsLanguage: "French");
        body["archives"] = gameArchives;
        body["stringsFiles"] = gameStringsFiles;

        (await Client.PutLoadOrderAndAwaitReady(body)).EnsureSuccessStatusCode();

        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Localized.esp&origin=LocalizedMod&type=acti&limit=10");
        return activators.GetProperty("items")[0].GetProperty("fullName").GetString();
    }

    [Fact]
    public async Task PutLoadOrder_TheGamesStringsFilesItNames_AreWhereALocalizedPluginsNamesAreRead()
    {
        var fx = ALocalizedPlugin();
        var plugin = fx.Plugins.Single();

        Assert.Equal("Levier", await TheLocalizedNameReadInFrench(
            fx, plugin with { NamedStrings = new PluginStrings([], []) }, [], [.. plugin.Strings.StringsFiles]));
    }

    private static StampedFile StringsPackedInAnArchive(LoadOrderEntry plugin)
    {
        var archive = Path.Combine(Path.GetDirectoryName(plugin.Path).Require(), "Localized - Main.ba2");
        StringsBa2.Pack(plugin.Strings.StringsFiles.Select(file => file.Path), archive);
        return HandedStrings.Stamped(archive);
    }

    public static TheoryData<string, Func<StampedFile, PluginStrings>, Func<StampedFile, StampedFile[]>> ArchivesNamed => new()
    {
        { "the game's archives", _ => new PluginStrings([], []), archive => [archive] },
        { "the plugin's own archives", archive => new PluginStrings([archive], []), _ => [] },
    };

    [Theory]
    [MemberData(nameof(ArchivesNamed))]
    public async Task PutLoadOrder_AnArchiveItNames_IsWhereALocalizedPluginsNamesAreRead(
        string namedIn, Func<StampedFile, PluginStrings> pluginsOwn, Func<StampedFile, StampedFile[]> theGames)
    {
        var fx = ALocalizedPlugin();
        var plugin = fx.Plugins.Single();
        var archive = StringsPackedInAnArchive(plugin);

        var name = await TheLocalizedNameReadInFrench(fx, plugin with { NamedStrings = pluginsOwn(archive) }, theGames(archive), []);

        Assert.Equal((namedIn, "Levier"), (namedIn, name));
    }
}
