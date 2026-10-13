using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class EditRecordApiTests : HostedTests
{
    private const string Plugin = "Scripted.esp";
    private const string Origin = "ScriptedMod";
    private const string Npc = "ScriptedNpc";

    private async Task<(string NpcFile, string FormKey)> LoadedAndTracked()
    {
        var fx = Owned(new PluginFixtureBuilder("api-edit")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Init(Origin)).EnsureSuccessStatusCode();
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single().Path).Require();
        return (
            Directory.EnumerateFiles(modFolder, $"{Npc} - *.json", SearchOption.AllDirectories).Single(),
            await Client.FirstFormKey(Plugin, Origin));
    }

    [Fact]
    public async Task AnEdit_IsWrittenToTheRecordsFile_And204()
    {
        var (file, formKey) = await LoadedAndTracked();

        var response = await Client.ScriptEdit(formKey, Plugin, Origin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Contains("0.75", await File.ReadAllTextAsync(file), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEditOfAFileHeldUnsaved_Is409_WithItsOwnRefusal()
    {
        var (file, formKey) = await LoadedAndTracked();
        await Client.HandUnsaved((file, await File.ReadAllTextAsync(file) + " "));

        var response = await Client.ScriptEdit(formKey, Plugin, Origin, "HeightMax", 0.75);

        Assert.Equal("UnsavedChanges", (await response.AssertIsProblem(HttpStatusCode.Conflict)).GetProperty("refusal").GetString());
    }
}
