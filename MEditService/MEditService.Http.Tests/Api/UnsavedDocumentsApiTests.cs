using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class UnsavedDocumentsApiTests : HostedTests
{
    private const string Plugin = "Typed.esp";
    private const string Origin = "TypedMod";
    private const string Npc = "TypedNpc";

    [Fact]
    public async Task PuttingAnUnsavedDocument_PushesRowsChanged_AndTheNextReadIsOfItsText_UntilClosingItReadsTheFileAgain()
    {
        using var fx = new PluginFixtureBuilder("unsaved-documents-api")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
        await Client.NextCheck(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        var document = OtherTool.SourceDocumentCarrying(OtherTool.ModFolderOf(fx, Origin), Plugin, Npc);
        using var stream = await Client.NotificationStream();

        var put = await Client.PutAsJsonAsync("/unsaved-document", new
        {
            path = document,
            text = File.ReadAllText(document).Replace(Npc, "TypedUnsaved", StringComparison.Ordinal),
            version = 1,
            opened = true,
        });

        Assert.Equal(HttpStatusCode.NoContent, put.StatusCode);
        Assert.Equal("TypedUnsaved", (await Client.Record(formKey)).GetProperty("editorId").GetString());
        await stream.EventsUntil("rows-changed", e => e.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey));

        var closed = await Client.DeleteAsync($"/unsaved-document?path={Uri.EscapeDataString(document)}");

        Assert.Equal(HttpStatusCode.NoContent, closed.StatusCode);
        Assert.Equal(Npc, (await Client.Record(formKey)).GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task AnUnsavedDocumentByARelativePath_Is400()
    {
        var response = await Client.PutAsJsonAsync("/unsaved-document", new { path = "plugin-source/Typed.esp/Typed.json", text = "{}", version = 1, opened = true });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
