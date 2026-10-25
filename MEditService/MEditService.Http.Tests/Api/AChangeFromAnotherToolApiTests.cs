using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class AChangeFromAnotherToolApiTests : HostedTests
{
    private const string Plugin = "Shared.esp";
    private const string Origin = "SharedMod";
    private const string Npc = "SharedNpc";

    private async Task<ScatteredFixtureData> ASourceMod()
    {
        var fx = new PluginFixtureBuilder("trace-another-tool")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        return fx;
    }

    [Fact]
    public async Task AHandEditToADocumentUnderTheSourceTree_PushesRowsChanged_AndTheNextReadAgrees()
    {
        using var fx = await ASourceMod();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        using var stream = await Client.NotificationStream();

        OtherTool.EditsASourceDocument(OtherTool.ModFolderOf(fx, Origin), Plugin, Npc, "RenamedByAnotherTool");
        await Client.NextSnapshot(fx);

        var rows = await stream.EventsUntil(
            "rows-changed", e => e.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey));
        Assert.Contains(rows, e => e.GetProperty("plugin").GetString() == Plugin);
        Assert.Equal("RenamedByAnotherTool", (await Client.Record(formKey)).GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task ARecordABackupCopyAlsoHolds_RefusesAnEdit_NamingBothDocuments()
    {
        using var fx = await ASourceMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var npc = await Client.FirstFormKey(Plugin, Origin);
        var original = OtherTool.SourceDocumentCarrying(modFolder, Plugin, Npc);
        OtherTool.CopiesASourceDocument(original, "Backup/{0}");

        var response = await Client.Edit(npc, Plugin, Origin, "EditorID", "EditedDespiteTheBackup");

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("AmbiguousSourceUnit", problem.GetProperty("refusal").GetString());
        var detail = problem.GetProperty("detail").GetString().Require();
        Assert.Contains(Path.GetRelativePath(modFolder, original), detail, StringComparison.Ordinal);
        Assert.Contains(Path.GetRelativePath(modFolder, AnotherTool.Beside(original, "Backup/{0}")), detail, StringComparison.Ordinal);
        Assert.Equal(Npc, (await Client.Record(npc)).GetProperty("editorId").GetString());
    }
}
