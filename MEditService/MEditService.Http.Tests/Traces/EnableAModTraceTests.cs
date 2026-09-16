using MEditService.Tests.Api;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Traces;

/// <summary>enable-a-mod: Modbench flips the modlist line and forgets it; the Instance recomputes
/// and the load order snapshot is what reaches mEdit, so mEdit's whole side is the snapshot
/// arriving and the plugins it brought answering.</summary>
[Collection(WebHostCollection.Name)]
public sealed class EnableAModTraceTests : IDisposable
{
    private const string BasePlugin = "Base.esp";
    private const string BaseMod = "BaseMod";
    private const string OptionalPlugin = "Optional.esp";
    private const string OptionalMod = "OptionalMod";

    private readonly MEditHost _app = new();
    private readonly HttpClient _client;
    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-enable-a-mod")
        .WithPlugin(BasePlugin, mod => mod.Npcs.AddNew("BaseNpc"), origin: BaseMod)
        .WithPlugin(OptionalPlugin, mod => mod.Npcs.AddNew("OptionalNpc"), origin: OptionalMod)
        .BuildScattered();

    public EnableAModTraceTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
        _instance.Dispose();
    }

    [Fact]
    public async Task EnablingAMod_BringsItsPluginIntoTheLoadOrder_AndItsRecordsIntoTheAnswers()
    {
        (await _client.PutLoadOrder(_instance, BaseMod)).EnsureSuccessStatusCode();
        Assert.DoesNotContain(await _client.Plugins(), p => p.GetProperty("name").GetString() == OptionalPlugin);

        var enabled = await _client.PutLoadOrder(_instance, BaseMod, OptionalMod);

        enabled.EnsureSuccessStatusCode();
        var optional = await _client.Plugin(OptionalPlugin);
        Assert.Equal(OptionalMod, optional.GetProperty("origin").GetString());
        Assert.True(optional.GetProperty("participates").GetBoolean());
        Assert.Equal(
            "OptionalNpc",
            (await _client.Record(await _client.FirstFormKey(OptionalPlugin))).GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task DisablingAMod_TakesItsPluginBackOut_AndItsRecordsStopAnswering()
    {
        (await _client.PutLoadOrder(_instance, BaseMod, OptionalMod)).EnsureSuccessStatusCode();
        var formKey = await _client.FirstFormKey(OptionalPlugin);

        (await _client.PutLoadOrder(_instance, BaseMod)).EnsureSuccessStatusCode();

        Assert.DoesNotContain(await _client.Plugins(), p => p.GetProperty("name").GetString() == OptionalPlugin);
        var records = await _client.GetAsync(new Uri($"/records?plugin={OptionalPlugin}&type=npc_", UriKind.Relative));
        records.EnsureSuccessStatusCode();
        Assert.DoesNotContain(formKey, await records.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }
}
