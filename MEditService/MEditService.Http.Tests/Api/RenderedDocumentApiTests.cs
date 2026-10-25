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
            .WithPlugin(Plugin, mod =>
            {
                mod.Npcs.AddNew("RenderedNpc");
                mod.Quests.AddNew("RenderedQuest");
            }, origin: Origin)
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

    private async Task<(string FileName, string Text)> WrittenByInit(ScatteredFixtureData fx, string pattern)
    {
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        var written = Directory.EnumerateFiles(ModFolderOf(fx), pattern, SearchOption.AllDirectories).Single();
        return (Path.GetFileName(written), File.ReadAllText(written));
    }

    [Theory]
    [InlineData("npc_", "RenderedNpc")]
    [InlineData("qust", "RenderedQuest")]
    public async Task ANonCompiledPluginCopy_IsTheFileInitWrites_ByNameAndText(string recordType, string editorId)
    {
        var fx = await NonCompiledPlugin();

        var rendered = await RenderedOk(await Client.FormKeyNamed(Plugin, Origin, recordType, editorId));

        Assert.Equal(await WrittenByInit(fx, $"{editorId} - *.json"), rendered);
    }

    [Fact]
    public async Task ANonCompiledPluginsHeader_IsTheFileInitWrites_ByNameAndText()
    {
        var fx = await NonCompiledPlugin();

        var rendered = await RenderedOk($"000000:{Plugin}");

        Assert.Equal(await WrittenByInit(fx, "000000_*.json"), rendered);
    }

    [Fact]
    public async Task ACompiledPluginCopy_IsNamedAsItsFileIs_AfterARenameByHand()
    {
        var fx = await NonCompiledPlugin();
        var npc = await Client.FormKeyNamed(Plugin, Origin, "npc_", "RenderedNpc");
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        var written = Directory.EnumerateFiles(ModFolderOf(fx), "RenderedNpc - *.json", SearchOption.AllDirectories).Single();

        File.Move(written, Path.Combine(Path.GetDirectoryName(written).Require(), "Named By Hand.json"));

        Assert.Equal("Named By Hand.json", (await RenderedOk(npc)).FileName);
    }
}
