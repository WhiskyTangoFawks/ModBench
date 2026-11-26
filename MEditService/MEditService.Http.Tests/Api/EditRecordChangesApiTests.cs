using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class EditRecordChangesApiTests : HostedTests
{
    private const string Plugin = "Editable.esp";
    private const string Origin = "EditableMod";
    private const string Npc = "EditableNpc";

    private async Task<(ScatteredFixtureData Fixture, string FormKey)> Loaded(bool compiledPlugin)
    {
        var fx = Owned(new PluginFixtureBuilder("api-edit-changes")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        if (compiledPlugin)
        {
            (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
            await Client.NextCheck(fx);
            await Client.PluginReportsCompiledPlugin(Plugin);
        }
        return (fx, await Client.FirstFormKey(Plugin, Origin));
    }

    private static string ModFolderOf(ScatteredFixtureData fx) => OtherTool.ModFolderOf(fx, Origin);

    private static string NpcFile(ScatteredFixtureData fx) =>
        Directory.EnumerateFiles(ModFolderOf(fx), $"{Npc} - *.json", SearchOption.AllDirectories).Single();

    [Fact]
    public async Task AnEditNamingAFieldTheRecordHasNot_Is404_WithItsOwnRefusal()
    {
        var (_, formKey) = await Loaded(compiledPlugin: true);

        var response = await Client.EditChanges(formKey, Plugin, Origin, "no_such_field", 1);

        Assert.Equal("FieldNotFound", (await response.AssertIsProblem(HttpStatusCode.NotFound)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AnEditOfANonCompiledPlugin_Is409_WithItsOwnRefusal()
    {
        var (_, formKey) = await Loaded(compiledPlugin: false);

        var response = await Client.EditChanges(formKey, Plugin, Origin, "HeightMax", 0.75);

        Assert.Equal("PluginNotCompiledPlugin", (await response.AssertIsProblem(HttpStatusCode.Conflict)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AFormIdThatIsNoFormKey_Is422_WithItsOwnRefusal()
    {
        var (_, formKey) = await Loaded(compiledPlugin: true);

        var response = await Client.EditChanges(formKey, Plugin, Origin, "FormKey", "not a FormKey");

        Assert.Equal("CodecRejected", (await response.AssertIsProblem(HttpStatusCode.UnprocessableEntity)).GetProperty("refusal").GetString());
    }
}
