using System.Text.Json;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Traces;

/// <summary>a-change-from-another-tool: a change from another tool and a change from Modbench are
/// the same signal, because each read model learns only by watching.</summary>
[Collection(WebHostCollection.Name)]
public sealed class AChangeFromAnotherToolTraceTests : HostedTests
{
    private const string Plugin = "Shared.esp";
    private const string Origin = "SharedMod";
    private const string Npc = "SharedNpc";
    private const string Quest = "SharedQuest";
    private const string Cell = "SharedCell";
    private const string PlacedRef = "SharedRef";

    private async Task<ScatteredFixtureData> ATrackedMod()
    {
        var fx = new PluginFixtureBuilder("trace-another-tool")
            .WithPlugin(Plugin, mod =>
            {
                mod.Npcs.AddNew(Npc).HeightMax = 0.5f;
                mod.Quests.Add(new Quest(mod) { EditorID = Quest, Filter = "OriginalFilter" });
                var cell = new Cell(mod) { EditorID = Cell };
                cell.Temporary.Add(new PlacedObject(mod) { EditorID = PlacedRef, Position = new P3Float(1f, 2f, 3f), Scale = 1f });
                var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
                subBlock.Cells.Add(cell);
                var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);
            }, origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return fx;
    }

    private async Task<JsonElement> Field(string formKey, string name) =>
        (await Client.Record(formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == name)
            .GetProperty("value");

    // A hand edit under the source tree is a change Modbench did not make, and it comes back as the
    // same rows-changed push an edit through the API produces.
    [Fact]
    public async Task AHandEditToADocumentUnderTheSourceTree_PushesRowsChanged_AndTheNextReadAgrees()
    {
        using var fx = await ATrackedMod();
        var formKey = await Client.FirstFormKey(Plugin);
        using var stream = await Client.NotificationStream();

        OtherTool.EditsASourceDocument(OtherTool.ModFolderOf(fx, Origin), Plugin, Npc, "RenamedByAnotherTool");

        var rows = await stream.EventsUntil(
            "rows-changed", e => e.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey));
        Assert.Contains(rows, e => e.GetProperty("plugin").GetString() == Plugin);
        Assert.Equal("RenamedByAnotherTool", (await Client.Record(formKey)).GetProperty("editorId").GetString());
    }

    // An untracked copy's bytes are its only truth, so the Index re-derives the copy itself and
    // names it whole: too many rows to list.
    [Fact]
    public async Task ARewriteOfAnUntrackedPluginsBytes_PushesPluginChanged_AndTheNextReadAgrees()
    {
        using var fx = new PluginFixtureBuilder("trace-another-tool-untracked")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(Plugin);
        using var stream = await Client.NotificationStream();

        OtherTool.WritesThePlugin(
            fx.Plugins.Single(p => p.Origin == Origin).Path, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.9f);

        var changed = await stream.EventsUntil("plugin-changed", e => e.GetProperty("plugin").GetString() == Plugin);
        Assert.Equal(Origin, changed[^1].GetProperty("origin").GetString());
        await Client.SequenceReaches(changed[^1].GetProperty("sequence").GetInt64());
        Assert.Equal(0.9, (await Field(formKey, "HeightMax")).GetDouble(), 3);
    }

    // A tracked copy's bytes are the mod's system of record and its rows come from the source
    // tree, so a rewrite is Commands' question, never the Index's projection.
    [Fact]
    public async Task ARewriteOfTheTrackedPluginsBytes_OpensAQuestionNamingTheCopy()
    {
        using var fx = await ATrackedMod();
        using var stream = await Client.NotificationStream();

        OtherTool.WritesThePlugin(
            fx.Plugins.Single(p => p.Origin == Origin).Path, mod => mod.Npcs.AddNew("AddedByAnotherTool"));

        var question = Assert.Single(await stream.EventsUntil("question-open"));
        Assert.Equal(Origin, question.GetProperty("origin").GetString());
        Assert.Contains(Plugin, question.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));
    }

    // A container record's document is one the repository lays out on its own terms, and a revert
    // by git is a write Modbench did not make: it reaches the next read the same way a flat
    // record's does.
    [Fact]
    public async Task AGitRevertOfAQuestsDocument_ReachesTheNextRead()
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var quest = await Client.FirstFormKey(Plugin, "qust");
        var before = await Client.Sequence();
        (await Client.Edit(quest, Plugin, Origin, "Filter", "EditedFilter")).EnsureSuccessStatusCode();
        await Client.SequenceReaches(before + 1);
        Assert.Equal("EditedFilter", (await Field(quest, "Filter")).GetString());
        var afterEdit = await Client.Sequence();

        OtherTool.RevertsASourceDocument(modFolder, Plugin, "EditedFilter");

        await Client.SequenceReaches(afterEdit + 1);
        Assert.Equal("OriginalFilter", (await Field(quest, "Filter")).GetString());
    }

    // An embedded child lives in its owning cell's document, so the revert of that one file is
    // what brings the placed ref back.
    [Fact]
    public async Task AGitRevertOfAPlacedRefsOwningCellDocument_ReachesTheNextRead()
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var placedRef = await Client.FirstFormKey(Plugin, "refr");
        var before = await Client.Sequence();
        (await Client.Edit(placedRef, Plugin, Origin, "Scale", 2.5)).EnsureSuccessStatusCode();
        await Client.SequenceReaches(before + 1);
        Assert.Equal(2.5f, (await Field(placedRef, "Scale")).GetSingle());
        var afterEdit = await Client.Sequence();

        OtherTool.RevertsASourceDocument(modFolder, Plugin, "2.5");

        await Client.SequenceReaches(afterEdit + 1);
        Assert.Equal(1f, (await Field(placedRef, "Scale")).GetSingle());
    }
}
