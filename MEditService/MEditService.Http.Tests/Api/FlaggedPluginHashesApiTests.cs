using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.Api;

public sealed class FlaggedPluginHashesApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>, IDisposable
{
    private readonly ScratchDirectory _root = new("api-flagged-plugin-hashes-");

    private HttpClient Client => loaded.Client;

    public void Dispose() => _root.Dispose();

    private string SmallPlugin()
    {
        var path = Path.Combine(_root, "Small.esp");
        new Fallout4Mod(ModKey.FromFileName("Small.esp"), Fallout4Release.Fallout4) { IsSmallMaster = true }.WriteToBinary(path);
        return path;
    }

    [Fact]
    public async Task AFlaggedPlugin_IsAnsweredWithItsHashesAtEachOriginal()
    {
        var path = SmallPlugin();

        var response = await Client.PostAsJsonAsync("/plugin-files/flagged-hashes", new { gameRelease = "Fallout4", files = new[] { new { path, flags = new Dictionary<string, bool> { ["Small"] = true } } } });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var answered = Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray());
        Assert.Equal((path, 2), (answered.GetProperty("path").GetString(), answered.GetProperty("hashes").GetArrayLength()));
    }

    [Fact]
    public async Task AFileThatIsNoPlugin_IsAnsweredWithNoHashes_BesideTheOthers()
    {
        var plugin = SmallPlugin();
        var notAPlugin = Path.Combine(_root, "Not.esp");
        File.WriteAllBytes(notAPlugin, new byte[64]);
        var small = new Dictionary<string, bool> { ["Small"] = true };

        var response = await Client.PostAsJsonAsync("/plugin-files/flagged-hashes", new { gameRelease = "Fallout4", files = new[] { new { path = notAPlugin, flags = small }, new { path = plugin, flags = small } } });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var answered = (await response.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray().Select(one => one.GetProperty("hashes").GetArrayLength()).ToArray();
        Assert.Equal([0, 2], answered);
    }

    [Fact]
    public async Task AFileThatCannotBeRead_Is400()
    {
        var path = Path.Combine(_root, "Gone.esp");

        var response = await Client.PostAsJsonAsync("/plugin-files/flagged-hashes", new { gameRelease = "Fallout4", files = new[] { new { path, flags = new Dictionary<string, bool> { ["Small"] = true } } } });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("""{"gameRelease": "Nowhere", "files": [{"path": "/x", "flags": {"Small": true}}]}""")]
    [InlineData("""{"gameRelease": "Fallout4", "files": [{"path": "/x", "flags": {}}]}""")]
    [InlineData("""{"gameRelease": "Fallout4", "files": [{"path": "/x", "flags": {"Nonsense": true}}]}""")]
    public async Task ARequestThatIsNotWhole_Is400(string body) =>
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.PostJson("/plugin-files/flagged-hashes", body)).StatusCode);
}
