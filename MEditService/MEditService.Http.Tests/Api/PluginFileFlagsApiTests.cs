using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.Api;

public sealed class PluginFileFlagsApiTests : HostedTests
{
    private readonly ScratchDirectory _root = new("api-plugin-file-flags-");

    protected override void DisposeFixtures() => _root.Dispose();

    private string PluginWritten(bool small)
    {
        var path = Path.Combine(_root, small ? "Small.esp" : "Plain.esp");
        new Fallout4Mod(ModKey.FromFileName(Path.GetFileName(path)), Fallout4Release.Fallout4) { IsSmallMaster = small }.WriteToBinary(path);
        return path;
    }

    [Fact]
    public async Task SettingAFlag_WritesItInPlace_AndAnUnknownFlagLeavesItsFileAsItWas()
    {
        var path = PluginWritten(small: false);
        var small = PluginWritten(small: true);

        var set = await Client.PostAsJsonAsync("/plugin-files/set-flags", new { gameRelease = "Fallout4", files = new[] { new { path, flags = new Dictionary<string, bool> { ["Small"] = true } } } });
        var unknown = await Client.PostAsJsonAsync("/plugin-files/set-flags", new { gameRelease = "Fallout4", files = new[] { new { path, flags = new Dictionary<string, bool> { ["Nonsense"] = true } } } });

        Assert.Equal(HttpStatusCode.OK, set.StatusCode);
        Assert.Equal(File.ReadAllBytes(small), File.ReadAllBytes(path));
        var refused = Assert.Single((await unknown.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refused").EnumerateArray());
        Assert.Equal("UnknownFlag", refused.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AFileThatIsNoPlugin_IsNamedWithWhy_AndLeftAsItWas()
    {
        var path = Path.Combine(_root, "Not.esp");
        File.WriteAllBytes(path, new byte[64]);

        var set = await Client.PostAsJsonAsync("/plugin-files/set-flags", new { gameRelease = "Fallout4", files = new[] { new { path, flags = new Dictionary<string, bool> { ["Small"] = true } } } });

        var refused = Assert.Single((await set.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refused").EnumerateArray());
        Assert.Equal(("NotAPlugin", new byte[64]), (refused.GetProperty("refusal").GetString(), File.ReadAllBytes(path)));
    }

    [Theory]
    [InlineData("""{"gameRelease": "Nowhere", "files": [{"path": "/x", "flags": {"Small": true}}]}""", "/plugin-files/set-flags")]
    [InlineData("""{"gameRelease": "Fallout4", "files": [{"path": "/x", "flags": {}}]}""", "/plugin-files/set-flags")]
    public async Task ARequestThatIsNotWhole_Is400(string body, string route) =>
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.PostJson(route, body)).StatusCode);
}
