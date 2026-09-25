using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

/// <summary>upgrade-a-mod: the install replaces the tracked folder's contents around .git, and from
/// there this is a-tracked-mod-changes-on-disk with the version as the tell that pre-selects the
/// baseline answer.</summary>
[Collection(WebHostCollection.Name)]
public sealed class UpgradeAModApiTests : HostedTests
{
    private const string Plugin = "Upgraded.esp";
    private const string Origin = "UpgradedMod";
    private const string Npc = "UpgradedNpc";
    private const string SecondPlugin = "UpgradedToo.esp";
    private const string SecondNpc = "UpgradedTooNpc";

    private async Task<ScatteredFixtureData> AnInstalledTrackedMod()
    {
        var fx = new PluginFixtureBuilder("trace-upgrade-a-mod")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        OtherTool.WritesTheFile(Path.Combine(OtherTool.ModFolderOf(fx, Origin), "meta.ini"), "version=1.0.0\n");
        (await Client.Track(Plugin, Origin)).EnsureSuccessStatusCode();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
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
        using var stream = await Client.NotificationStream();

        TheUpgradeLands(fx);

        var question = Assert.Single(await stream.EventsUntil("question-open"));
        Assert.Equal(Origin, question.GetProperty("origin").GetString());
        Assert.True(question.GetProperty("externalChangeMetaChanged").GetBoolean());
        Assert.Equal("1.0.0", question.GetProperty("externalChangeOldVersion").GetString());
        Assert.Equal("2.0.0", question.GetProperty("externalChangeNewVersion").GetString());
    }

    [Fact]
    public async Task TheBaselineAnswerToAnUpgrade_ThenTheUsersRebase_AnswersTheNextReadWithTheUpgradedContent()
    {
        using var fx = await AnInstalledTrackedMod();
        var formKey = await Client.FirstFormKey(Plugin);
        using var stream = await Client.NotificationStream();
        TheUpgradeLands(fx);
        await stream.EventsUntil("question-open");

        var answered = await Client.PostAsJsonAsync("/plugins/external-change/absorb", new { origin = Origin });
        answered.EnsureSuccessStatusCode();
        Assert.Empty((await answered.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refused").EnumerateArray());
        var before = await Client.Sequence();

        OtherTool.RebasesTheEditBranch(OtherTool.ModFolderOf(fx, Origin));

        await Client.SequenceReaches(before + 1);
        var height = (await Client.Record(formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax");
        Assert.Equal(0.9, height.GetProperty("value").GetDouble(), 3);
    }

    // The scattered fixture gives each plugin a folder of its own, so the second is written beside
    // the first and listed by hand.
    private async Task<(ScatteredFixtureData Fx, string ModFolder)> AnInstalledTrackedModOfTwoPlugins()
    {
        var fx = new PluginFixtureBuilder("trace-upgrade-a-mod-of-two")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var second = Path.Combine(modFolder, SecondPlugin);
        OtherTool.WritesThePlugin(second, mod => mod.Npcs.AddNew(SecondNpc).HeightMax = 0.5f);
        LoadOrderEntry[] plugins = [.. fx.Plugins, new LoadOrderEntry(SecondPlugin, second, Origin, fx.Plugins.Count, Enabled: true, Winning: true)];
        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();
        (await Client.Track([(Plugin, Origin), (SecondPlugin, Origin)])).EnsureSuccessStatusCode();
        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();
        return (fx, modFolder);
    }

    [Fact]
    public async Task TheBaselineAnswer_WhenTheSecondPluginsCommitFails_AnswersTheFirstApplied_AndTheSecondRefused()
    {
        var (fx, modFolder) = await AnInstalledTrackedModOfTwoPlugins();
        using var owned = fx;
        using var stream = await Client.NotificationStream();
        OtherTool.WritesThePlugin(Path.Combine(modFolder, Plugin), mod => mod.Npcs.AddNew(Npc).HeightMax = 0.9f);
        OtherTool.WritesThePlugin(Path.Combine(modFolder, SecondPlugin), mod => mod.Npcs.AddNew(SecondNpc).HeightMax = 0.9f);
        await stream.EventsUntil("question-open");
        RefMoveHook.RefuseMainMovesNaming(modFolder, SecondPlugin);

        var answered = await Client.PostAsJsonAsync("/plugins/external-change/absorb", new { origin = Origin });

        answered.EnsureSuccessStatusCode();
        var body = await answered.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(
            [(Plugin, Origin)],
            body.GetProperty("applied").EnumerateArray().Select(p => (p.GetProperty("name").GetString(), p.GetProperty("origin").GetString())));
        var refused = Assert.Single(body.GetProperty("refused").EnumerateArray());
        Assert.Equal(
            (SecondPlugin, Origin, "CommitFailed"),
            (refused.GetProperty("plugin").GetProperty("name").GetString(), refused.GetProperty("plugin").GetProperty("origin").GetString(),
                refused.GetProperty("refusal").GetString()));
        Assert.Contains("main is held by another tool", refused.GetProperty("message").GetString(), StringComparison.Ordinal);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("trackedFilesRefusal").ValueKind);
    }
}
