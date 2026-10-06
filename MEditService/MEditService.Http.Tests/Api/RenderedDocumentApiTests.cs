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

    [Fact]
    public async Task AnUntrackedCopy_IsTheTextTrackWritesToItsFile()
    {
        var fx = await Untracked();
        var copies = new Dictionary<string, string>
        {
            ["RenderedNpc - "] = await Client.FormKeyNamed(Plugin, Origin, "npc_", "RenderedNpc"),
            ["RenderedQuest - "] = await Client.FormKeyNamed(Plugin, Origin, "qust", "RenderedQuest"),
            ["RenderedRoom - "] = await Client.FormKeyNamed(Plugin, Origin, "cell", "RenderedRoom"),
            ["000000_"] = $"000000:{Plugin}",
        };
        var rendered = new Dictionary<string, string>();
        foreach (var (file, formKey) in copies)
        {
            var response = await Rendered(formKey);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            rendered[file] = (await response.Body()).GetProperty("text").GetString().Require();
        }

        (await Client.Track(Origin)).EnsureSuccessStatusCode();

        var modFolder = Path.GetDirectoryName(fx.Plugins.Single().Path).Require();
        foreach (var (file, text) in rendered)
        {
            var written = Directory.EnumerateFiles(modFolder, $"{file}*.json", SearchOption.AllDirectories).Single();
            Assert.Equal(File.ReadAllText(written), text);
        }
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
