using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class RenderedDocumentApiTests : HostedTests
{
    private const string Plugin = "Rendered.esp";
    private const string Origin = "RenderedMod";

    private async Task<ScatteredFixtureData> NonCompiledPlugin()
    {
        var fx = Owned(new PluginFixtureBuilder("api-rendered-document")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("RenderedNpc"), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return fx;
    }

    private Task<HttpResponseMessage> Rendered(string formKey) =>
        Client.GetAsync(new Uri(
            $"/plugins/{Plugin}/records/{Uri.EscapeDataString(formKey)}/rendered-document?origin={Origin}",
            UriKind.Relative));

    private static string ModFolderOf(ScatteredFixtureData fx) => OtherTool.ModFolderOf(fx, Origin);

    private async Task<(string FileName, string Text)> RenderedOk(string formKey)
    {
        var response = await Rendered(formKey);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var document = await response.Body();
        return (document.GetProperty("fileName").GetString().Require(), document.GetProperty("text").GetString().Require());
    }

    private async Task<(string FileName, string Text)> WrittenByInit(ScatteredFixtureData fx, string underPluginSource)
    {
        (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
        var file = Path.Combine(PluginSourceRoot.In(ModFolderOf(fx), Plugin), underPluginSource);
        return (Path.GetFileName(file), File.ReadAllText(file));
    }

    [Fact]
    public async Task ANonCompiledPluginCopy_IsTheFileInitWrites_ByNameAndText()
    {
        var fx = await NonCompiledPlugin();

        var rendered = await RenderedOk(await Client.FormKeyNamed(Plugin, Origin, "npc_", "RenderedNpc"));

        Assert.Equal(await WrittenByInit(fx, "Npcs/RenderedNpc - 000800_Rendered.esp.json"), rendered);
    }
}
