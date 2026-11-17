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
        (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
        await Client.NextCheck(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        var document = OtherTool.SourceDocumentCarrying(OtherTool.ModFolderOf(fx, Origin), Plugin, Npc);
        using var stream = await Client.NotificationStream();

        var response = await Client.PutAsJsonAsync("/unsaved-document", new
        {
            path = document,
            text = File.ReadAllText(document).Replace(Npc, "TypedUnsaved", StringComparison.Ordinal),
            version = 1,
            opened = true,
        });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("TypedUnsaved", (await Client.Record(formKey)).GetProperty("editorId").GetString());
        await stream.EventsUntil("rows-changed", e => e.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey));
    }

    [Fact]
    public async Task PuttingADocumentThatDoesNotRead_PushesPluginChanged_AndThePluginSaysWhyItsRowsAreTheLastGoodRead()
    {
        using var fx = new PluginFixtureBuilder("unsaved-documents-unread-api")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
        await Client.NextCheck(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        var document = OtherTool.SourceDocumentCarrying(OtherTool.ModFolderOf(fx, Origin), Plugin, Npc);
        using var stream = await Client.NotificationStream();

        var response = await Client.PutAsJsonAsync("/unsaved-document", new
        {
            path = document,
            text = File.ReadAllText(document).Replace($"\"{Npc}\"", "\"TypedUnsaved", StringComparison.Ordinal),
            version = 1,
            opened = true,
        });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        await stream.EventsUntil("plugin-changed", e => e.GetProperty("plugin").GetString() == Plugin);
        Assert.Contains((await Client.Plugin(Plugin)).GetProperty("laterReadFailure").EnumerateArray(), stop => stop.GetProperty("message").GetString() is { } message && message.Contains("is no record document", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ClosingTheDocument_ReadsItsFileAgain_AndTheNextReadIsOfTheFile()
    {
        using var fx = new PluginFixtureBuilder("unsaved-document-close-api")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
        await Client.NextCheck(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        var document = OtherTool.SourceDocumentCarrying(OtherTool.ModFolderOf(fx, Origin), Plugin, Npc);
        (await Client.PutAsJsonAsync("/unsaved-document", new
        {
            path = document,
            text = File.ReadAllText(document).Replace(Npc, "TypedUnsaved", StringComparison.Ordinal),
            version = 1,
            opened = true,
        })).EnsureSuccessStatusCode();

        var response = await Client.DeleteAsync($"/unsaved-document?path={Uri.EscapeDataString(document)}");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(Npc, (await Client.Record(formKey)).GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task ADocumentOpenedAtALowerVersion_ReplacesTheOneHeld_AsAfterAReloadOfTheExtension()
    {
        using var fx = new PluginFixtureBuilder("unsaved-document-reopen-api")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
        await Client.NextCheck(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        var document = OtherTool.SourceDocumentCarrying(OtherTool.ModFolderOf(fx, Origin), Plugin, Npc);
        var text = File.ReadAllText(document);
        (await Client.PutAsJsonAsync("/unsaved-document", new { path = document, text = text.Replace(Npc, "TypedFirst", StringComparison.Ordinal), version = 9, opened = true })).EnsureSuccessStatusCode();

        (await Client.PutAsJsonAsync("/unsaved-document", new { path = document, text = text.Replace(Npc, "TypedAfterReload", StringComparison.Ordinal), version = 1, opened = true })).EnsureSuccessStatusCode();

        Assert.Equal("TypedAfterReload", (await Client.Record(formKey)).GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task APutDocumentByARelativePath_Is400()
    {
        var response = await Client.PutAsJsonAsync("/unsaved-document", new { path = "plugin-source/Typed.esp/Typed.json", text = "{}", version = 1, opened = true });

        await response.AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ADeletedDocumentByARelativePath_Is400()
    {
        var response = await Client.DeleteAsync("/unsaved-document?path=plugin-source%2FTyped.esp%2FTyped.json");

        await response.AssertIsProblem(HttpStatusCode.BadRequest);
    }
}
