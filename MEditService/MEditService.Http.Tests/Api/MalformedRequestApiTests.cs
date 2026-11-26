using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

[Collection(LoadedApiCollection.Name)]
public sealed class MalformedRequestApiTests(LoadedApiFixture<TestPluginFixture> loaded)
{
    private const string ARecord = """{"formKey": "000800:TestPlugin.esp", "plugin": {"name": "TestPlugin.esp", "origin": "Data/"}}""";
    private const string Copy = "\"step\": {\"copy\": [\"a.nif\"]}";
    private const string Init = """{"name": "VersionedMod", "modFolder": "m", "commit": true""";

    private static string BuildOf(string step) =>
        $"{{\"mods\": [{{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", \"folder\": \"f\", \"step\": {{{step}}}}}], \"exclusionMark\": \".mohidden\"}}";

    private static string InitOf(string sourceFolder) => $$$"""{"mods": [{{{Init}}}, "sourceFolder": {{{sourceFolder}}}}]}""";

    public static TheoryData<string, string, string> NotARequest => new()
    {
        { "POST /build", "no mod", "{\"mods\": [], \"exclusionMark\": \".mohidden\"}" },
        { "POST /build", "no folder", $"{{\"mods\": [{{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", {Copy}}}], \"exclusionMark\": \".mohidden\"}}" },
        { "POST /build", "no exclusion mark", $"{{\"mods\": [{{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", \"folder\": \"f\", {Copy}}}]}}" },
        { "POST /build", "no step", "{\"mods\": [{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", \"folder\": \"f\"}], \"exclusionMark\": \".mohidden\"}" },
        { "POST /build", "a step of two kinds", BuildOf("\"copy\": [\"a.nif\"], \"compile\": [\"a.esp\"]") },
        { "POST /build", "a step naming no path", BuildOf("\"copy\": []") },
        { "POST /build", "a compile of a plugin in a folder", BuildOf("\"compile\": [\"a/b.esp\"]") },
        { "POST /build", "a decompile of a plugin in a folder", BuildOf("\"decompile\": [\"a/b.esp\"]") },
        { "POST /build", "an archive's file outside the folder", BuildOf("\"pack\": [{\"path\": \"Main.ba2\", \"files\": [\"/a.nif\"]}]") },
        { "POST /build", "an unpack beside a pack", BuildOf("\"pack\": [{\"path\": \"Main.ba2\", \"files\": [\"a.nif\"]}], \"unpack\": [{\"path\": \"Main.ba2\", \"files\": [\"a.nif\"]}]") },
        { "POST /build", "an unpack naming no file", BuildOf("\"unpack\": [{\"path\": \"Main.ba2\", \"files\": []}]") },
        { "POST /build", "an unpack of a file outside the folder", BuildOf("\"unpack\": [{\"path\": \"Main.ba2\", \"files\": [\"../a.nif\"]}]") },
        {
            "POST /build", "a variant both a BA2 and a BSA",
            $"{{\"mods\": [{{\"name\": \"ModBuildOutcome\", \"sourceFolder\": \"s\", \"folder\": \"f\", {Copy}}}], \"exclusionMark\": \".mohidden\", " +
            "\"archives\": {\"general\": {\"ba2\": {\"version\": 1, \"compressed\": true}, \"bsa\": {\"version\": 105, \"compressed\": true}}, " +
            "\"textures\": {\"ba2\": {\"version\": 1, \"compressed\": true}}}}"
        },
        { "POST /version-in-git", "no mod", """{"mods": []}""" },
        { "POST /version-in-git", "a mod without a name", """{"mods": [{"name": "", "modFolder": "m", "commit": true, "sourceFolder": {"path": "s", "in": "NewRepository", "buildFile": "{}"}}]}""" },
        { "POST /version-in-git", "a mod without a folder", """{"mods": [{"name": "VersionedMod", "commit": true, "sourceFolder": {"path": "s", "in": "NewRepository", "buildFile": "{}"}}]}""" },
        { "POST /version-in-git", "a mod without commit", """{"mods": [{"name": "VersionedMod", "modFolder": "m", "sourceFolder": {"path": "s", "in": "NewRepository", "buildFile": "{}"}}]}""" },
        { "POST /version-in-git", "a mod without the repository that holds it", InitOf("""{"path": "s", "buildFile": "{}"}""") },
        { "POST /version-in-git", "a mod without a source folder", InitOf("""{"in": "NewRepository", "buildFile": "{}"}""") },
        { "POST /version-in-git", "a mod without a build file", InitOf("""{"path": "s", "in": "NewRepository"}""") },
        { "POST /version-in-git", "an asset outside the mod folder", InitOf("""{"path": "s", "in": "NewRepository", "assets": ["../a.dds"], "buildFile": "{}"}""") },
        { "POST /records/compare", "no copies", """{"copies": []}""" },
        { "POST /records/compare", "a copy missing its origin", """{"copies": [{"formKey": "000800:WithNpc.esp", "plugin": {"name": "WithNpc.esp", "origin": ""}}]}""" },
        { "POST /records/copy-states", "no FormKeys", """{"formKeys": []}""" },
        { "POST /records/copy-states", "a plugin missing its origin", """{"formKeys": ["000800:WithNpc.esp"], "plugin": {"name": "WithNpc.esp", "origin": ""}}""" },
        { "POST /records/000800%3AWithNpc.esp/compare", "a text with no origin", """{"plugin": {"name": "WithNpc.esp", "origin": ""}, "documentText": "{}"}""" },
        { "POST /records/delete-changes", "no records", """{"records": []}""" },
        { "POST /records/delete-changes", "a record with no origin", """{"records": [{"formKey": "000800:TestPlugin.esp", "plugin": {"name": "TestPlugin.esp", "origin": ""}}]}""" },
        { "POST /records/copy-changes", "no destination", $$"""{"records": [{{ARecord}}], "mode": "Override", "destinations": []}""" },
        {
            "POST /records/copy-changes", "a copy as new that replaces",
            $$"""{"records": [{{ARecord}}], "mode": "New", "destinations": [{"name": "TestPlugin.esp", "origin": "Data/"}], "replace": true}"""
        },
        { "POST /plugins/TestPlugin.esp/create-record-changes", "no record type", """{"origin": "Data/", "recordType": ""}""" },
        { "POST /plugins/create", "no name", """{"origin": "SomeMod", "name": "", "folder": "/mods/SomeMod"}""" },
        { "POST /plugins/create", "a blank origin", """{"origin": "   ", "name": "New.esp", "folder": "/mods/SomeMod"}""" },
        { "POST /plugins/create", "a blank folder", """{"origin": "SomeMod", "name": "New.esp", "folder": "   "}""" },
        { "POST /plugins/create", "no folder", """{"origin": "SomeMod", "name": "New.esp"}""" },
        { "POST /plugins/compile", "no plugin", """{"plugins": []}""" },
        { "POST /plugins/compile", "a plugin without an origin", """{"plugins": [{"name": "Compiled.esp", "origin": ""}]}""" },
        { "POST /plugins/decompile", "no plugin", """{"plugins": [], "force": false}""" },
        {
            "POST /plugins/decompile-and-repair", "a source folder with no build file",
            """{"plugins": [{"plugin": {"name": "Short.esp", "origin": "NewMod"}, "sourceFolder": {"path": "s", "in": "NewRepository"}}], "force": false}"""
        },
        {
            "POST /plugins/decompile-and-repair", "a source folder with no repository to hold it",
            """{"plugins": [{"plugin": {"name": "Short.esp", "origin": "NewMod"}, "sourceFolder": {"path": "s", "buildFile": "{}"}}], "force": false}"""
        },
        { "POST /plugins/rename-source-changes", "no plugin name", """{"origin": "SourceMod", "name": "", "newName": "Renamed.esp", "namedByFileName": true}""" },
        { "POST /plugins/rename-source-changes", "a blank origin", """{"origin": " ", "name": "CompiledPlugin.esp", "newName": "Renamed.esp", "namedByFileName": true}""" },
        { "POST /script-names/rename-source-changes", "no new name", """{"name": "Attached", "newName": ""}""" },
        { "POST /plugins/facts", "no plugins", "{}" },
        { "POST /plugins/facts", "a plugin without an origin", """{"plugins": [{"name": "Shared.esp"}]}""" },
        { "POST /plugins/facts", "a plugin without a name", """{"plugins": [{"origin": "ModB"}]}""" },
        { "POST /plugins/indexing", "no plugins", "{}" },
        { "POST /plugins/indexing", "a plugin without an origin", """{"plugins": [{"name": "Shared.esp"}]}""" },
        { "POST /plugins/file-paths", "keys of no plugin", """{"keys": ["000800:Names.esp"], "known": []}""" },
        { "POST /plugins/file-paths?plugin=Names.esp", "a plugin without its origin", """{"known": []}""" },
        { "POST /plugins/problems", "keys of no plugin", """{"keys": ["000800:Refers.esp"], "known": []}""" },
        { "POST /plugins/problems?plugin=Refers.esp", "a plugin without its origin", """{"known": []}""" },
        { "POST /load-order/filter", "no source", """{"sql": "SELECT form_key FROM \"NPC_\""}""" },
        { "PUT /unsaved-document", "a document by a relative path", """{"path": "plugin-source/Typed.esp/Typed.json", "text": "{}", "version": 1, "opened": true}""" },
        { "POST /plugin-files/set-flags", "an unknown game", """{"gameRelease": "Nowhere", "files": [{"path": "/x", "flags": {"Small": true}}]}""" },
        { "POST /plugin-files/set-flags", "a file with no flag", """{"gameRelease": "Fallout4", "files": [{"path": "/x", "flags": {}}]}""" },
        { "POST /plugin-files/flagged-hashes", "an unknown game", """{"gameRelease": "Nowhere", "files": [{"path": "/x", "flags": {"Small": true}}]}""" },
        { "POST /plugin-files/flagged-hashes", "a file with no flag", """{"gameRelease": "Fallout4", "files": [{"path": "/x", "flags": {}}]}""" },
        { "POST /plugin-files/flagged-hashes", "a name that is no load flag", """{"gameRelease": "Fallout4", "files": [{"path": "/x", "flags": {"Nonsense": true}}]}""" },
        { "POST /archives/contents", "an unknown game", """{"gameRelease": "Nowhere", "archives": ["/x.ba2"]}""" },
        { "POST /archives/contents", "no archive", """{"gameRelease": "Fallout4", "archives": []}""" },
        { "POST /archives/copies", "an unknown game", """{"gameRelease": "Nowhere", "archive": "/x.ba2", "files": ["a.nif"]}""" },
        { "POST /archives/copies", "no file", """{"gameRelease": "Fallout4", "archive": "/x.ba2", "files": []}""" },
        { "POST /archives/copies", "a blank archive", """{"gameRelease": "Fallout4", "archive": " ", "files": ["a.nif"]}""" },
        { "POST /clone-submodules", "no submodule", """{"submodules": []}""" },
        { "POST /clone-submodules", "a submodule with no pin", """{"submodules": [{"folder": "/source/Mod"}]}""" },
    };

    [Theory]
    [MemberData(nameof(NotARequest))]
    public async Task ARequestThatDoesNotSayWhatToDo_Is400(string request, string lacking, string body)
    {
        var (method, route) = (request[..request.IndexOf(' ', StringComparison.Ordinal)], request[(request.IndexOf(' ', StringComparison.Ordinal) + 1)..]);
        using var message = new HttpRequestMessage(new HttpMethod(method), route) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };

        var response = await loaded.Client.SendAsync(message);

        Assert.Equal((lacking, HttpStatusCode.BadRequest), (lacking, response.StatusCode));
    }

    [Theory]
    [InlineData("GET", "/load-order/sequence/await?atLeast=1&timeoutMs=0")]
    [InlineData("GET", "/plugin-source/record?path=plugin-source%2FFiled.esp%2FNpcs%2FFiledNpc.json")]
    [InlineData("DELETE", "/unsaved-document?path=plugin-source%2FTyped.esp%2FTyped.json")]
    public async Task ARequestOfNoBodyThatDoesNotSayWhatToDo_Is400(string method, string route)
    {
        using var message = new HttpRequestMessage(new HttpMethod(method), route);

        var response = await loaded.Client.SendAsync(message);

        Assert.Equal((route, HttpStatusCode.BadRequest), (route, response.StatusCode));
    }

    [Theory]
    [InlineData("\"manifest\": \"{}\"", "ManifestFile is missing")]
    [InlineData("\"manifestFile\": \"M.manifest.json\"", "Manifest is missing")]
    [InlineData("\"manifestFile\": \"a/M.manifest.json\", \"manifest\": \"{}\"", "bare file name")]
    [InlineData("\"modFolderManifest\": \"{}\"", "ModFolderManifestFile is missing")]
    [InlineData("\"modFolderManifestFile\": \"M.manifest.json\"", "ModFolderManifest is missing")]
    [InlineData("\"modFolderManifestFile\": \"../M.manifest.json\", \"modFolderManifest\": \"{}\"", "ModFolderManifestFile must be a bare file name")]
    public async Task AVersionInGitWithHalfAManifest_IsRefused_NamingWhatIsWrong(string manifestMembers, string named)
    {
        var response = await loaded.Client.PostJson(
            "/version-in-git", InitOf($$"""{"path": "s", "in": "NewRepository", "buildFile": "{}", {{manifestMembers}}}"""));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains(named, await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }
}
