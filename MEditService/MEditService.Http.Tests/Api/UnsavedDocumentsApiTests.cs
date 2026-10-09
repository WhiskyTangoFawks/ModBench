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
    public async Task PuttingTheUnsavedDocuments_PushesRowsChanged_AndTheNextReadIsOfTheUnsavedText()
    {
        using var fx = new PluginFixtureBuilder("unsaved-documents-api")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(Plugin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        var document = OtherTool.SourceDocumentCarrying(OtherTool.ModFolderOf(fx, Origin), Plugin, Npc);
        using var stream = await Client.NotificationStream();

        var response = await Client.PutAsJsonAsync("/unsaved-documents", new
        {
            documents = new[] { new { path = document, text = File.ReadAllText(document).Replace(Npc, "TypedUnsaved", StringComparison.Ordinal) } },
        });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        await stream.EventsUntil("rows-changed", e => e.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey));
        Assert.Equal("TypedUnsaved", (await Client.Record(formKey)).GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task PuttingADocumentByARelativePath_Is400()
    {
        var response = await Client.PutAsJsonAsync("/unsaved-documents", new
        {
            documents = new[] { new { path = Path.Combine("plugin-source", Plugin, "Typed.json"), text = "{}" } },
        });

        await response.AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task PuttingNoDocuments_Is400()
    {
        var response = await Client.PutAsJsonAsync("/unsaved-documents", new { });

        await response.AssertIsProblem(HttpStatusCode.BadRequest);
    }
}
