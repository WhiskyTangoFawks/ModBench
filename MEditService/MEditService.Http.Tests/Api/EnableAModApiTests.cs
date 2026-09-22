using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

/// <summary>enable-a-mod: Modbench flips the modlist line and forgets it; the Instance recomputes
/// and the load order snapshot is what reaches mEdit, so mEdit's whole side is the snapshot
/// arriving and the plugins it brought answering.</summary>
[Collection(WebHostCollection.Name)]
public sealed class EnableAModApiTests : HostedTests
{
    private const string BasePlugin = "Base.esp";
    private const string BaseMod = "BaseMod";
    private const string OptionalPlugin = "Optional.esp";
    private const string OptionalMod = "OptionalMod";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-enable-a-mod")
        .WithPlugin(BasePlugin, mod => mod.Npcs.AddNew("BaseNpc"), origin: BaseMod)
        .WithPlugin(OptionalPlugin, mod => mod.Npcs.AddNew("OptionalNpc"), origin: OptionalMod)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    [Fact]
    public async Task EnablingAMod_BringsItsPluginIntoTheLoadOrder_AndItsRecordsIntoTheAnswers()
    {
        (await Client.PutLoadOrder(_instance, BaseMod)).EnsureSuccessStatusCode();
        Assert.DoesNotContain(await Client.Plugins(), p => p.GetProperty("name").GetString() == OptionalPlugin);

        var enabled = await Client.PutLoadOrder(_instance, BaseMod, OptionalMod);

        enabled.EnsureSuccessStatusCode();
        var optional = await Client.Plugin(OptionalPlugin);
        Assert.Equal(OptionalMod, optional.GetProperty("origin").GetString());
        Assert.True(optional.GetProperty("participates").GetBoolean());
        Assert.Equal(
            "OptionalNpc",
            (await Client.Record(await Client.FirstFormKey(OptionalPlugin))).GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task DisablingAMod_TakesItsPluginBackOut_AndItsRecordsStopAnswering()
    {
        (await Client.PutLoadOrder(_instance, BaseMod, OptionalMod)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(OptionalPlugin);

        (await Client.PutLoadOrder(_instance, BaseMod)).EnsureSuccessStatusCode();

        Assert.DoesNotContain(await Client.Plugins(), p => p.GetProperty("name").GetString() == OptionalPlugin);
        var records = await Client.GetAsync(new Uri($"/records?plugin={OptionalPlugin}&type=npc_", UriKind.Relative));
        records.EnsureSuccessStatusCode();
        Assert.DoesNotContain(formKey, await records.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }
}
