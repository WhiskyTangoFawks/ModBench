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
    public async Task AFilesVariants_AreItsBytesWithTheLoadFlagsFlipped()
    {
        var path = PluginWritten(small: false);

        var response = await Client.PostAsJsonAsync("/plugin-files/flag-variants", new { gameRelease = "Fallout4", paths = new[] { path } });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var answered = Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("applied").EnumerateArray());
        Assert.Equal(3, answered.GetProperty("variants").GetArrayLength());
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

    [Theory]
    [InlineData("""{"gameRelease": "Fallout4", "paths": []}""", "/plugin-files/flag-variants")]
    [InlineData("""{"gameRelease": "Nowhere", "paths": ["/x"]}""", "/plugin-files/flag-variants")]
    [InlineData("""{"gameRelease": "Fallout4", "files": [{"path": "/x", "flags": {}}]}""", "/plugin-files/set-flags")]
    public async Task ARequestThatIsNotWhole_Is400(string body, string route) =>
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.PostJson(route, body)).StatusCode);
}
