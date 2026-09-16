using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Tests.Api;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Traces;

/// <summary>upgrade-a-mod: the install replaces the tracked folder's contents around .git, and from
/// there this is a-tracked-mod-changes-on-disk with the version as the tell that pre-selects the
/// baseline answer.</summary>
[Collection(WebHostCollection.Name)]
public sealed class UpgradeAModTraceTests : IDisposable
{
    private const string Plugin = "Upgraded.esp";
    private const string Origin = "UpgradedMod";
    private const string Npc = "UpgradedNpc";

    private readonly MEditHost _app = new();
    private readonly HttpClient _client;

    public UpgradeAModTraceTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }

    private async Task<ScatteredFixtureData> AnInstalledTrackedMod()
    {
        var fx = new PluginFixtureBuilder("trace-upgrade-a-mod")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();
        (await _client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        OtherTool.WritesTheFile(Path.Combine(OtherTool.ModFolderOf(fx, Origin), "meta.ini"), "version=1.0.0\n");
        (await _client.Track(Origin)).EnsureSuccessStatusCode();
        (await _client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return fx;
    }

    // The new release's files land in the folder the old ones came from, .git kept: the version in
    // meta.ini moves and the plugin's bytes move with it.
    private static void TheUpgradeLands(ScatteredFixtureData fx)
    {
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        OtherTool.WritesTheFile(Path.Combine(modFolder, "meta.ini"), "version=2.0.0\n");
        OtherTool.WritesThePlugin(
            fx.Plugins.Single(p => p.Origin == Origin).Path, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.9f);
    }

    [Fact]
    public async Task AnUpgradeOfATrackedMod_OpensOneQuestionCarryingTheVersionTell()
    {
        using var fx = await AnInstalledTrackedMod();
        using var stream = await _client.NotificationStream();

        TheUpgradeLands(fx);

        var question = Assert.Single(await stream.EventsUntil("question-open"));
        Assert.Equal(Origin, question.GetProperty("origin").GetString());
        Assert.True(question.GetProperty("externalChangeMetaChanged").GetBoolean());
        Assert.Equal("1.0.0", question.GetProperty("externalChangeOldVersion").GetString());
        Assert.Equal("2.0.0", question.GetProperty("externalChangeNewVersion").GetString());
    }

    // The baseline answer the version pre-selects: the upgrade becomes the new history on main, and
    // what the client reads next is the upgraded content.
    [Fact]
    public async Task TheBaselineAnswerToAnUpgrade_Applies_AndTheUpgradedContentAnswersTheNextRead()
    {
        using var fx = await AnInstalledTrackedMod();
        var formKey = await _client.FirstFormKey(Plugin);
        using var stream = await _client.NotificationStream();
        TheUpgradeLands(fx);
        await stream.EventsUntil("question-open");
        var before = await _client.Sequence();

        var answered = await _client.PostAsJsonAsync("/plugins/external-change/absorb", new { origin = Origin });

        answered.EnsureSuccessStatusCode();
        var outcome = await answered.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(outcome.GetProperty("succeeded").GetBoolean(), outcome.GetProperty("refusalReason").GetString());
        await _client.SequenceReaches(before + 1);
        var height = (await _client.Record(formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax");
        Assert.Equal(0.9, height.GetProperty("value").GetDouble(), 3);
    }
}
