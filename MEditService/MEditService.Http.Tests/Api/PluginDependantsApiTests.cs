using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

public sealed class PluginDependantsApiTests : IDisposable
{
    private readonly MEditHost _app = new();
    private readonly HttpClient _client;

    public PluginDependantsApiTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }

    [Fact]
    public async Task GetDependants_AfterALoad_NamesThePluginsListingTheFileNameAsAMaster()
    {
        using var fx = new PluginFixtureBuilder("api-dependants")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("Base"), origin: "BaseMod")
            .WithPlugin("Child.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.GetOrAddAsOverride(built.Single(m => m.ModKey.FileName == "Base.esm").Npcs.First());
            }, origin: "ChildMod")
            .BuildScattered();
        (await _client.PutLoadOrderAndAwaitReady(new
        {
            plugins = fx.Plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(fx.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(fx.Plugins),
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            gameRelease = "Fallout4",
        })).EnsureSuccessStatusCode();

        var answer = await _client.GetFromJsonAsync<JsonElement>("/plugins/Base.esm/dependants?origin=BaseMod");

        var dependant = Assert.Single(answer.GetProperty("dependants").EnumerateArray());
        Assert.Equal(("Child.esp", "ChildMod"), (dependant.GetProperty("name").GetString(), dependant.GetProperty("origin").GetString()));
        Assert.Empty(answer.GetProperty("unreadable").EnumerateArray());
    }

    [Fact]
    public async Task GetDependants_WithNoLoadOrder_Is503()
    {
        var response = await _client.GetAsync(new Uri("/plugins/Base.esm/dependants?origin=BaseMod", UriKind.Relative));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    [Fact]
    public async Task GetDependants_WithNoOrigin_Is400()
    {
        var response = await _client.GetAsync(new Uri("/plugins/Base.esm/dependants", UriKind.Relative));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
