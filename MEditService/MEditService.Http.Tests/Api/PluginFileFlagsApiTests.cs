using System.Net;
using System.Net.Http.Json;
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
    public async Task SettingAFlag_WritesItInPlace()
    {
        var path = PluginWritten(small: false);
        var small = PluginWritten(small: true);

        var set = await Client.PostAsJsonAsync("/plugin-files/set-flags", new { gameRelease = "Fallout4", files = new[] { new { path, flags = new Dictionary<string, bool> { ["Small"] = true } } } });

        Assert.Equal(HttpStatusCode.OK, set.StatusCode);
        Assert.Equal(File.ReadAllBytes(small), File.ReadAllBytes(path));
    }
}
