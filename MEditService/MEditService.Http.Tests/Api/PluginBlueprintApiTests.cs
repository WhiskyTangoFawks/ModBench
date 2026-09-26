using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Http.Tests.Api;

// plugins.md, Drag and drop, story 3: the drop check reads each plugin's blueprint fact beside its
// masters, from the plugin listing.
[Collection(WebHostCollection.Name)]
public sealed class PluginBlueprintApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    // Starfield's header flag 0x800 means blueprint (TES5Edit wbDefinitionsSF1.pas). Fallout 4
    // gives the bit no meaning, so a plugin carrying it is not one.
    private const int StarfieldBlueprintFlag = 0x800;

    [Fact]
    public async Task ThePluginListing_CarriesTheBlueprintFact_FalseForAGameWithoutBlueprintPlugins()
    {
        using var fx = new PluginFixtureBuilder("api-blueprint-fact")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("FromBase"))
            .WithPlugin("Flagged.esm", mod =>
            {
                mod.Npcs.AddNew("FromFlagged");
                mod.ModHeader.Flags |= (Fallout4ModHeader.HeaderFlag)StarfieldBlueprintFlag;
            })
            .BuildScattered();

        var response = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        response.EnsureSuccessStatusCode();

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        var blueprint = plugins.EnumerateArray()
            .Where(p => p.GetProperty("name").GetString() is "Base.esm" or "Flagged.esm")
            .ToDictionary(p => p.GetProperty("name").GetString() ?? "", p => p.GetProperty("isBlueprint").GetBoolean());
        Assert.Equal(new Dictionary<string, bool> { ["Base.esm"] = false, ["Flagged.esm"] = false }, blueprint);
    }
}
