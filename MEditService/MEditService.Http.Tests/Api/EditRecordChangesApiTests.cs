using System.Net;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

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

    private static string ModFolderOf(ScatteredFixtureData fx) => Path.GetDirectoryName(fx.Plugins.Single().Path).Require();

    private static string NpcFile(ScatteredFixtureData fx) =>
        Directory.EnumerateFiles(ModFolderOf(fx), $"{Npc} - *.json", SearchOption.AllDirectories).Single();

    [Fact]
    public async Task AnEdit_IsAnsweredWithTheNewTextOfTheRecordsDocument_AndWritesNothing()
    {
        var (fx, formKey) = await Loaded(tracked: true);
        var file = NpcFile(fx);
        var before = TreeSnapshot.Of(ModFolderOf(fx));

        var response = await Client.EditChanges(formKey, Plugin, Origin, "HeightMax", 0.75, File.ReadAllText(file));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var answer = await response.Body();
        Assert.Empty(answer.GetProperty("moves").EnumerateArray());
        var document = Assert.Single(answer.GetProperty("documents").EnumerateArray());
        Assert.Equal(Path.GetRelativePath(ModFolderOf(fx), file), document.GetProperty("path").GetString());
        Assert.Contains("0.75", document.GetProperty("text").GetString().Require(), StringComparison.Ordinal);
        Assert.Equal(JsonValueKind.Null, answer.GetProperty("newFormKey").ValueKind);
        Assert.Equal(before, TreeSnapshot.Of(ModFolderOf(fx)));
    }

    [Fact]
    public async Task AnEditWithoutTheDocumentsText_Is400()
    {
        var (_, formKey) = await Loaded(tracked: true);

        await (await Client.EditChanges(formKey, Plugin, Origin, "HeightMax", 0.75, text: null)).AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task AnEditNamingAFieldTheRecordHasNot_Is404_WithItsOwnRefusal()
    {
        var (fx, formKey) = await Loaded(tracked: true);

        var response = await Client.EditChanges(formKey, Plugin, Origin, "no_such_field", 1, File.ReadAllText(NpcFile(fx)));

        Assert.Equal("FieldNotFound", (await response.AssertIsProblem(HttpStatusCode.NotFound)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AnEditOfAnUntrackedPlugin_Is409_WithItsOwnRefusal()
    {
        var (_, formKey) = await Loaded(tracked: false);

        var response = await Client.EditChanges(formKey, Plugin, Origin, "HeightMax", 0.75, "{}");

        Assert.Equal("PluginNotTracked", (await response.AssertIsProblem(HttpStatusCode.Conflict)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AFormIdThatIsNoFormKey_Is422_WithItsOwnRefusal()
    {
        var (fx, formKey) = await Loaded(tracked: true);

        var response = await Client.EditChanges(formKey, Plugin, Origin, "FormKey", "not a FormKey", File.ReadAllText(NpcFile(fx)));

        Assert.Equal("CodecRejected", (await response.AssertIsProblem(HttpStatusCode.UnprocessableEntity)).GetProperty("refusal").GetString());
    }
}
