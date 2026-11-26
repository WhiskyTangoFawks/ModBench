using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.Api;

[Collection(LoadedApiCollection.Name)]
public sealed class FlaggedPluginHashesApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IDisposable
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
    public async Task AFileThatCannotBeRead_IsNamedWithWhy_BesideTheOthersAnswered()
    {
        var gone = Path.Combine(_root, "Gone.esp");
        var plugin = SmallPlugin();
        var small = new Dictionary<string, bool> { ["Small"] = true };

        var response = await Client.PostAsJsonAsync("/plugin-files/flagged-hashes", new { gameRelease = "Fallout4", files = new[] { new { path = gone, flags = small }, new { path = plugin, flags = small } } });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var answered = (await response.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray().ToArray();
        Assert.Equal((gone, 0, true), (answered[0].GetProperty("path").GetString(), answered[0].GetProperty("hashes").GetArrayLength(), answered[0].GetProperty("unreadable").ValueKind == JsonValueKind.String));
        Assert.Equal((2, JsonValueKind.Null), (answered[1].GetProperty("hashes").GetArrayLength(), answered[1].GetProperty("unreadable").ValueKind));
    }
}
