using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class SharedFilenameEditApiTests : HostedTests
{
    private const string PluginName = "Shared.esp";
    private const string WinningOrigin = "WinningMod";
    private const string OverriddenOrigin = "OverriddenMod";

    [Fact]
    public async Task AnEditAimedAtTheOverriddenCopyOfASharedFilename_LandsInThatOriginsTree()
    {
        using var fx = new PluginFixtureBuilder("api-overridden-plugin")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("OverriddenNpc"), origin: OverriddenOrigin)
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("WinningNpc"), origin: WinningOrigin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit([WinningOrigin, OverriddenOrigin])).EnsureSuccessStatusCode();
        var formKey = $"000800:{PluginName}";

        var response = await Client.EditChanges(formKey, PluginName, OverriddenOrigin, "HeightMax", 0.75);

        response.EnsureSuccessStatusCode();
        var document = (await response.Body()).GetProperty("documents").EnumerateArray().Single();
        var path = document.GetProperty("path").GetString().Require();
        Assert.StartsWith(OtherTool.ModFolderOf(fx, OverriddenOrigin) + Path.DirectorySeparatorChar, path, StringComparison.Ordinal);
    }
}
