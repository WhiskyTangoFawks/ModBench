using System.Net;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Http.Tests.Api;

public sealed class EditRecordChangesApiTests : HostedTests
{
    private const string Plugin = "Editable.esp";
    private const string Origin = "EditableMod";
    private const string Npc = "EditableNpc";

    private async Task<(ScatteredFixtureData Fixture, string FormKey)> Loaded(bool tracked)
    {
        var fx = Owned(new PluginFixtureBuilder("api-edit-changes")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        if (tracked)
        {
            (await Client.Track(Origin)).EnsureSuccessStatusCode();
            await Client.NextSnapshot(fx);
            await Client.PluginReportsTracked(Plugin);
        }
        return (fx, await Client.FirstFormKey(Plugin, Origin));
    }

    private static string ModFolderOf(ScatteredFixtureData fx, string plugin) =>
        Path.GetDirectoryName(fx.Plugins.Single(p => Path.GetFileName(p.Path) == plugin).Path).Require();

    private static string ModFolderOf(ScatteredFixtureData fx) => Path.GetDirectoryName(fx.Plugins.Single().Path).Require();

    private static string NpcFile(ScatteredFixtureData fx) =>
        Directory.EnumerateFiles(ModFolderOf(fx), $"{Npc} - *.json", SearchOption.AllDirectories).Single();

    [Fact]
    public async Task AnEdit_IsAnsweredWithTheNewTextOfTheRecordsDocument_AtItsPath_AndWritesNothing()
    {
        var (fx, formKey) = await Loaded(tracked: true);
        var file = NpcFile(fx);
        var before = TreeSnapshot.Of(ModFolderOf(fx));

        var response = await Client.EditChanges(formKey, Plugin, Origin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var answer = await response.Body();
        Assert.Empty(answer.GetProperty("moves").EnumerateArray());
        var document = Assert.Single(answer.GetProperty("documents").EnumerateArray());
        Assert.Equal(file, document.GetProperty("path").GetString());
        Assert.Contains("0.75", document.GetProperty("text").GetString().Require(), StringComparison.Ordinal);
        Assert.Equal(JsonValueKind.Null, answer.GetProperty("newFormKey").ValueKind);
        Assert.Equal(before, TreeSnapshot.Of(ModFolderOf(fx)));
    }

    [Fact]
    public async Task ClearingDeleted_FillsFromTheUnsavedTextOfATrackedMaster()
    {
        var fx = Owned(new PluginFixtureBuilder("api-edit-changes-masters")
            .WithPlugin("Master.esp", mod => mod.Npcs.AddNew("Saved"), origin: "MasterMod")
            .WithPlugin("Override.esp", (mod, before) =>
                mod.Npcs.Add(new Npc(before[0].Npcs.Single().FormKey, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = DeletedFlag.Bit }),
                origin: "OverrideMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(["MasterMod", "OverrideMod"])).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked("Override.esp");
        var formKey = await Client.FirstFormKey("Override.esp", "OverrideMod");
        var masterFile = Directory.EnumerateFiles(ModFolderOf(fx, "Master.esp"), "Saved - *.json", SearchOption.AllDirectories).Single();

        await Client.HandUnsaved((masterFile, File.ReadAllText(masterFile).Replace("Saved", "Unsaved", StringComparison.Ordinal)));

        var response = await Client.EditChanges(formKey, "Override.esp", "OverrideMod", "MajorRecordFlagsRaw", 0);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var document = Assert.Single((await response.Body()).GetProperty("documents").EnumerateArray());
        Assert.Contains("Unsaved", document.GetProperty("text").GetString().Require(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEditNamingAFieldTheRecordHasNot_Is404_WithItsOwnRefusal()
    {
        var (fx, formKey) = await Loaded(tracked: true);

        var response = await Client.EditChanges(formKey, Plugin, Origin, "no_such_field", 1);

        Assert.Equal("FieldNotFound", (await response.AssertIsProblem(HttpStatusCode.NotFound)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AnEditOfAnUntrackedPlugin_Is409_WithItsOwnRefusal()
    {
        var (_, formKey) = await Loaded(tracked: false);

        var response = await Client.EditChanges(formKey, Plugin, Origin, "HeightMax", 0.75);

        Assert.Equal("PluginNotTracked", (await response.AssertIsProblem(HttpStatusCode.Conflict)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AnEditOfAPluginWhoseSourceIsUnreadable_Is409_WithItsOwnRefusal()
    {
        var (fx, formKey) = await Loaded(tracked: true);
        Directory.Delete(PluginSourceRoot.In(ModFolderOf(fx), Plugin), recursive: true);

        var response = await Client.EditChanges(formKey, Plugin, Origin, "HeightMax", 0.75);

        Assert.Equal("PluginSourceUnreadable", (await response.AssertIsProblem(HttpStatusCode.Conflict)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AFormIdThatIsNoFormKey_Is422_WithItsOwnRefusal()
    {
        var (fx, formKey) = await Loaded(tracked: true);

        var response = await Client.EditChanges(formKey, Plugin, Origin, "FormKey", "not a FormKey");

        Assert.Equal("CodecRejected", (await response.AssertIsProblem(HttpStatusCode.UnprocessableEntity)).GetProperty("refusal").GetString());
    }
}
