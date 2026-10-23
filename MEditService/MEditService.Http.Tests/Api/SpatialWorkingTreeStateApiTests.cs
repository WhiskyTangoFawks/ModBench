using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.Api;

public sealed class SpatialWorkingTreeStateApiTests : HostedTests
{
    private const string Plugin = "Spatial.esp";
    private const string Origin = "SpatialMod";

    [Fact]
    public async Task AnEditedPlacedRef_IsBeneathItsPlugin()
    {
        FormKey placedRef = default;
        using var fx = new PluginFixtureBuilder("trace-edit-spatial")
            .WithPlugin(Plugin, mod => placedRef = ContainerModPlugin.AddTo(mod).TemporaryRef, origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);

        (await Client.Edit(placedRef.ToString(), Plugin, Origin, "EditorID", "Renamed")).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);

        await Wire.Eventually(
            async () => JsonDocument.Parse(await Client.GetStringAsync($"/plugins/{Plugin}/working-tree-states-beneath?origin={Origin}"))
                .RootElement.GetProperty("plugin").EnumerateArray().Any(state => state.GetString() == "Modified"),
            "the edited ref beneath its plugin");
    }
}
