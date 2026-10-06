using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Http.Tests.Api;

public sealed class RenderedDocumentApiTests : HostedTests
{
    private const string Plugin = "Rendered.esp";
    private const string Origin = "RenderedMod";

    private async Task<ScatteredFixtureData> Untracked()
    {
        var fx = Owned(new PluginFixtureBuilder("api-rendered-document")
            .WithPlugin(Plugin, mod =>
            {
                mod.Npcs.AddNew("RenderedNpc");
                mod.Quests.AddNew("RenderedQuest");
                var room = new Cell(mod) { EditorID = "RenderedRoom" };
                room.Temporary.Add(new PlacedObject(mod) { EditorID = "RenderedRef" });
                var subBlock = new CellSubBlock { BlockNumber = 0 };
                subBlock.Cells.Add(room);
                var block = new CellBlock { BlockNumber = 0 };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);
            }, origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return fx;
    }

    private Task<HttpResponseMessage> Rendered(string formKey, string plugin = Plugin, string? origin = Origin) =>
        Client.GetAsync(new Uri(
            $"/plugins/{plugin}/records/{Uri.EscapeDataString(formKey)}/rendered-document" +
            (origin is null ? string.Empty : $"?origin={origin}"),
            UriKind.Relative));

    private static string ModFolderOf(ScatteredFixtureData fx) => Path.GetDirectoryName(fx.Plugins.Single().Path).Require();

    private async Task<(string FileName, string Text)> RenderedOk(string formKey)
    {
        var response = await Rendered(formKey);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var document = await response.Body();
        return (document.GetProperty("fileName").GetString().Require(), document.GetProperty("text").GetString().Require());
    }

    // A null record type is the plugin header, whose file is named for its FormKey alone.
    [Theory]
    [InlineData("npc_", "RenderedNpc")]
    [InlineData("qust", "RenderedQuest")]
    [InlineData("cell", "RenderedRoom")]
    [InlineData(null, null)]
    public async Task AnUntrackedCopy_IsTheFileTrackWrites_ByNameAndText(string? recordType, string? editorId)
    {
        var fx = await Untracked();
        var formKey = recordType is null ? $"000000:{Plugin}" : await Client.FormKeyNamed(Plugin, Origin, recordType, editorId.Require());
        var (fileName, text) = await RenderedOk(formKey);

        (await Client.Track(Origin)).EnsureSuccessStatusCode();

        var written = Directory.EnumerateFiles(
            ModFolderOf(fx), editorId is null ? "000000_*.json" : $"{editorId} - *.json", SearchOption.AllDirectories).Single();
        Assert.Equal(Path.GetFileName(written), fileName);
        Assert.Equal(File.ReadAllText(written), text);
    }

    [Fact]
    public async Task ATrackedCopy_IsNamedAsItsFileIs_AfterARenameByHand()
    {
        var fx = await Untracked();
        var npc = await Client.FormKeyNamed(Plugin, Origin, "npc_", "RenderedNpc");
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(Plugin);
        var written = Directory.EnumerateFiles(ModFolderOf(fx), "RenderedNpc - *.json", SearchOption.AllDirectories).Single();

        File.Move(written, Path.Combine(Path.GetDirectoryName(written).Require(), "Named By Hand.json"));

        Assert.Equal("Named By Hand.json", (await RenderedOk(npc)).FileName);
    }

    [Fact]
    public async Task ACopyThePluginDoesNotHold_Is404()
    {
        await Untracked();
        var npc = await Client.FormKeyNamed(Plugin, Origin, "npc_", "RenderedNpc");

        await (await Rendered(npc, origin: "AnotherMod")).AssertIsProblem(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task ACopyNamedWithoutItsOrigin_Is400()
    {
        await Untracked();

        await (await Rendered($"000000:{Plugin}", origin: null)).AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task BeforeAnyLoadOrder_Is503()
    {
        await (await Rendered($"000000:{Plugin}")).AssertIsProblem(HttpStatusCode.ServiceUnavailable);
    }
}
