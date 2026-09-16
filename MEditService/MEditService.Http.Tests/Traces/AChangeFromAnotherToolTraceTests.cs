using MEditService.Tests.Api;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Traces;

/// <summary>a-change-from-another-tool: a change from another tool and a change from Modbench are
/// the same signal, because each read model learns only by watching.</summary>
[Collection(WebHostCollection.Name)]
public sealed class AChangeFromAnotherToolTraceTests : IDisposable
{
    private const string Plugin = "Shared.esp";
    private const string Origin = "SharedMod";
    private const string Npc = "SharedNpc";

    private readonly MEditHost _app = new();
    private readonly HttpClient _client;

    public AChangeFromAnotherToolTraceTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }

    private async Task<ScatteredFixtureData> ATrackedMod()
    {
        var fx = new PluginFixtureBuilder("trace-another-tool")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();
        (await _client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await _client.Track(Origin)).EnsureSuccessStatusCode();
        (await _client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return fx;
    }

    // A hand edit under the source tree is a change Modbench did not make, and it comes back as the
    // same rows-changed push an edit through the API produces.
    [Fact]
    public async Task AHandEditToADocumentUnderTheSourceTree_PushesRowsChanged_AndTheNextReadAgrees()
    {
        using var fx = await ATrackedMod();
        var formKey = await _client.FirstFormKey(Plugin);
        using var stream = await _client.NotificationStream();

        OtherTool.EditsASourceDocument(OtherTool.ModFolderOf(fx, Origin), Plugin, Npc, "RenamedByAnotherTool");

        var rows = await stream.EventsUntil(
            "rows-changed", e => e.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey));
        Assert.Contains(rows, e => e.GetProperty("plugin").GetString() == Plugin);
        Assert.Equal("RenamedByAnotherTool", (await _client.Record(formKey)).GetProperty("editorId").GetString());
    }

    // The plugin's own bytes are the other half of the same watch: they are the mod's system of
    // record, so a rewrite is a question rather than a projection.
    [Fact]
    public async Task ARewriteOfTheTrackedPluginsBytes_OpensAQuestionNamingTheCopy()
    {
        using var fx = await ATrackedMod();
        using var stream = await _client.NotificationStream();

        OtherTool.WritesThePlugin(
            fx.Plugins.Single(p => p.Origin == Origin).Path, mod => mod.Npcs.AddNew("AddedByAnotherTool"));

        var question = Assert.Single(await stream.EventsUntil("question-open"));
        Assert.Equal(Origin, question.GetProperty("origin").GetString());
        Assert.Contains(Plugin, question.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));
    }
}
