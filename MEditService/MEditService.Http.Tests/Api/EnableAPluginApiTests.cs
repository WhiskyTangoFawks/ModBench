using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

/// <summary>enable-a-plugin: the plugins.txt splice reaches mEdit as the next snapshot, whose
/// active plugins Mod Management decided.</summary>
[Collection(WebHostCollection.Name)]
public sealed class EnableAPluginApiTests : HostedTests
{
    private const string First = "First.esp";
    private const string Second = "Second.esp";
    private const string FirstMod = "FirstMod";
    private const string SecondMod = "SecondMod";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-enable-a-plugin")
        .WithPlugin(First, mod => mod.Npcs.AddNew("FirstNpc"), origin: FirstMod)
        .WithPlugin(Second, mod => mod.Npcs.AddNew("SecondNpc"), origin: SecondMod)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    [Fact]
    public async Task EnablingAPlugin_BringsItIntoTheLoadOrder()
    {
        var dormant = _instance.Plugins.Select(p => p.Name == Second ? p with { Enabled = false } : p);
        (await Client.PutLoadOrder(_instance, dormant)).EnsureSuccessStatusCode();
        Assert.False((await Client.Plugin(Second)).GetProperty("inLoadOrder").GetBoolean());

        (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

        Assert.True((await Client.Plugin(Second)).GetProperty("inLoadOrder").GetBoolean());
    }

    [Fact]
    public async Task ReorderingThePlugins_ComesBackInTheNewOrder()
    {
        (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();
        Assert.Equal(0, (await Client.Plugin(First)).GetProperty("loadOrderIndex").GetInt32());

        var swapped = _instance.Plugins.Select(p => p with { Slot = p.Name == First ? 1 : 0 });
        (await Client.PutLoadOrder(_instance, swapped)).EnsureSuccessStatusCode();

        Assert.Equal(1, (await Client.Plugin(First)).GetProperty("loadOrderIndex").GetInt32());
        Assert.Equal(0, (await Client.Plugin(Second)).GetProperty("loadOrderIndex").GetInt32());
    }
}
