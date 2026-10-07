using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Http.Tests.Api;

public sealed class AChangeFromAnotherToolApiTests : HostedTests
{
    private const string Plugin = "Shared.esp";
    private const string Origin = "SharedMod";
    private const string Npc = "SharedNpc";
    private const string Quest = "SharedQuest";
    private const string Cell = "SharedCell";
    private const string PlacedRef = "SharedRef";
    private const string World = "SharedWorld";

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
                mod.Worldspaces.Add(new Worldspace(mod) { EditorID = World });
            }, origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(Plugin);
        return fx;
    }

    private async Task<JsonElement> Field(string formKey, string name) =>
        (await Client.Record(formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == name)
            .GetProperty("value");

    [Fact]
    public async Task AHandEditToADocumentUnderTheSourceTree_PushesRowsChanged_AndTheNextReadAgrees()
    {
        using var fx = await ATrackedMod();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        using var stream = await Client.NotificationStream();

        OtherTool.EditsASourceDocument(OtherTool.ModFolderOf(fx, Origin), Plugin, Npc, "RenamedByAnotherTool");
        await Client.NextSnapshot(fx);

        var rows = await stream.EventsUntil(
            "rows-changed", e => e.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey));
        Assert.Contains(rows, e => e.GetProperty("plugin").GetString() == Plugin);
        Assert.Equal("RenamedByAnotherTool", (await Client.Record(formKey)).GetProperty("editorId").GetString());
    }

    [Theory]
    [InlineData("RenamedByHand.json")]
    [InlineData("SortedByHand/{0}")]
    public async Task ACommittedDocumentRenamedByHand_KeepsItsRecord(string renamedTo)
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var npc = await Client.FirstFormKey(Plugin, Origin);
        var quest = await Client.FirstFormKey(Plugin, Origin, "qust");
        using var stream = await Client.NotificationStream();
        OtherTool.EditsASourceDocument(modFolder, Plugin, "OriginalFilter", "SettledFilter");
        await Client.NextSnapshot(fx);
        await stream.EventsUntil("rows-changed", e => Names(e, quest));

        OtherTool.RenamesASourceDocument(modFolder, Plugin, Npc, renamedTo);

        var frames = await FramesOfTheSnapshotAnchoredBy(fx, stream, modFolder, quest);
        Assert.DoesNotContain(frames, f => f.Kind == "rows-changed" && Names(f.Data, npc));
        Assert.Equal(Npc, (await Client.Record(npc)).GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task ADialogResponseCopiedIntoAQuestWhoseDocumentWasRenamedByHand_IsReadUnderThatQuest()
    {
        const string master = "DialogueMaster.esm";
        const string masterOrigin = "DialogueMasterMod";
        const string patch = "DialoguePatch.esp";
        const string patchOrigin = "DialoguePatchMod";
        FormKey response = FormKey.Null, topicKey = FormKey.Null;
        using var fx = new PluginFixtureBuilder("trace-another-tool-dialogue")
            .WithPlugin(master, mod =>
            {
                var quest = new Quest(mod) { EditorID = "SharedDialogueQuest" };
                var topic = new DialogTopic(mod) { EditorID = "SharedDialogueTopic" };
                var line = new DialogResponses(mod) { EditorID = "CopiedResponse" };
                topic.Responses.Add(line);
                quest.DialogTopics.Add(topic);
                mod.Quests.Add(quest);
                (response, topicKey) = (line.FormKey, topic.FormKey);
            }, origin: masterOrigin)
            .WithPlugin(patch, (mod, earlier) =>
            {
                var quest = earlier[0].Quests.Single().DeepCopy();
                quest.DialogTopics.Single().Responses.Clear();
                mod.Quests.Set(quest);
            }, origin: patchOrigin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(patchOrigin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(patch);
        var patchFolder = OtherTool.ModFolderOf(fx, patchOrigin);
        OtherTool.RenamesASourceDocument(patchFolder, patch, "\"SharedDialogueQuest\"", "RenamedByHand.json");

        var copied = await Client.Copy(response.ToString(), (master, masterOrigin), "Override", (patch, patchOrigin));

        copied.EnsureSuccessStatusCode();
        Assert.Single((await copied.Body()).GetProperty("applied").EnumerateArray());
        await Client.NextSnapshot(fx);
        await Wire.Eventually(
            async () => (await Client.GetFromJsonAsync<JsonElement>(
                    $"/plugins/{patch}/records/{Uri.EscapeDataString(topicKey.ToString())}/children?origin={patchOrigin}"))
                .EnumerateArray().Any(child => child.GetProperty("formKey").GetString() == response.ToString()),
            "the copied response to be read under its topic in the patch");
    }

    [Fact]
    public async Task ARecordABackupCopyAlsoHolds_RefusesAnEdit_NamingBothDocuments()
    {
        using var fx = await ATrackedMod();
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
        Assert.Contains(Path.GetRelativePath(modFolder, OtherTool.Beside(original, "Backup/{0}")), detail, StringComparison.Ordinal);
        Assert.Equal(Npc, (await Client.Record(npc)).GetProperty("editorId").GetString());
        await Client.NextSnapshot(fx);
        await ItsPluginSourceReadsAs(unreadable: true);
    }

    [Theory]
    [InlineData("RenamedByHand.json")]
    [InlineData("Misnamed - 000900_Shared.esp.json")]
    [InlineData("SortedByHand/{0}")]
    [InlineData("SortedByHand/RenamedByHand.json")]
    public async Task ACommittedDocumentCopiedThenDeletedByHand_IsDiagnosedUntilTheDelete_AndKeepsItsRecord(
        string copiedTo)
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var npc = await Client.FirstFormKey(Plugin, Origin);
        var original = OtherTool.SourceDocumentCarrying(modFolder, Plugin, Npc);

        OtherTool.CopiesASourceDocument(original, copiedTo);
        await Client.NextSnapshot(fx);

        var diagnosed = await TheFilesItsReadStoppedAt();
        Assert.Contains(Path.GetRelativePath(modFolder, original), diagnosed);
        Assert.Contains(
            Path.GetRelativePath(modFolder, OtherTool.Beside(original, copiedTo)), diagnosed);

        OtherTool.DeletesTheFile(original);
        await Client.NextSnapshot(fx);

        await ItsPluginSourceReadsAs(unreadable: false);
        Assert.Equal(Npc, (await Client.Record(npc)).GetProperty("editorId").GetString());
    }

    private static string ACellCopiedUnderAKeyOfItsOwn(string modFolder, string cell)
    {
        var original = Path.GetDirectoryName(OtherTool.SourceDocumentCarrying(modFolder, Plugin, $"\"{Cell}\"")).Require();
        var copy = OtherTool.Beside(original, "CopiedCell - 000950_Shared.esp");
        OtherTool.CopiesASourceDirectory(original, Path.GetFileName(copy));
        var document = Directory.GetFiles(copy).Single();
        var text = File.ReadAllText(document);
        var at = text.IndexOf(cell, StringComparison.Ordinal);
        File.WriteAllText(document, text[..at] + "000950:Shared.esp" + text[(at + cell.Length)..]);
        return document;
    }

    [Fact]
    public async Task APlacedReferenceTwoCellsCarry_IsDiagnosed_NamingBothDocuments()
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var cell = await Client.FirstFormKey(Plugin, Origin, "cell");
        var original = OtherTool.SourceDocumentCarrying(modFolder, Plugin, $"\"{Cell}\"");

        var copy = ACellCopiedUnderAKeyOfItsOwn(modFolder, cell);
        await Client.NextSnapshot(fx);

        var diagnosed = await TheFilesItsReadStoppedAt();
        Assert.Contains(Path.GetRelativePath(modFolder, original), diagnosed);
        Assert.Contains(Path.GetRelativePath(modFolder, copy), diagnosed);
    }

    [Fact]
    public async Task APlacedReferenceTwoCellsCarry_RefusesAnEdit_NamingBothDocuments()
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var cell = await Client.FirstFormKey(Plugin, Origin, "cell");
        var placedRef = await Client.FormKeyNamed(Plugin, Origin, "refr", PlacedRef);
        var original = OtherTool.SourceDocumentCarrying(modFolder, Plugin, $"\"{Cell}\"");
        var copy = ACellCopiedUnderAKeyOfItsOwn(modFolder, cell);

        var response = await Client.Edit(placedRef, Plugin, Origin, "Scale", 2.5);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("AmbiguousSourceUnit", problem.GetProperty("refusal").GetString());
        var detail = problem.GetProperty("detail").GetString().Require();
        Assert.Contains(Path.GetRelativePath(modFolder, original), detail, StringComparison.Ordinal);
        Assert.Contains(Path.GetRelativePath(modFolder, copy), detail, StringComparison.Ordinal);
        await Client.NextSnapshot(fx);
        await ItsPluginSourceReadsAs(unreadable: true);
    }

    [Theory]
    [InlineData("{0}")]
    [InlineData("copy.json")]
    public async Task ABackupCopyIntoAFolderThatAlreadyStood_IsDiagnosed_NamingBothDocuments(string copiedTo)
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var quest = await Client.FirstFormKey(Plugin, Origin, "qust");
        var original = OtherTool.SourceDocumentCarrying(modFolder, Plugin, Npc);
        using var stream = await Client.NotificationStream();
        Directory.CreateDirectory(OtherTool.Beside(original, "Backup"));
        OtherTool.EditsASourceDocument(modFolder, Plugin, "OriginalFilter", "SettledFilter");
        await Client.NextSnapshot(fx);
        await stream.EventsUntil("rows-changed", e => Names(e, quest));

        OtherTool.CopiesASourceDocument(original, $"Backup/{copiedTo}");
        await Client.NextSnapshot(fx);

        var diagnosed = await TheFilesItsReadStoppedAt();
        Assert.Contains(Path.GetRelativePath(modFolder, original), diagnosed);
        Assert.Contains(
            Path.GetRelativePath(modFolder, OtherTool.Beside(original, $"Backup/{copiedTo}")), diagnosed);
    }

    [Theory]
    [InlineData("Backup/{0}")]
    [InlineData("Backup/copy.json")]
    public async Task ABackupCopyDeletedByHand_LiftsTheDiagnosis(string copiedTo)
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var npc = await Client.FirstFormKey(Plugin, Origin);
        var original = OtherTool.SourceDocumentCarrying(modFolder, Plugin, Npc);
        using var stream = await Client.NotificationStream();
        OtherTool.CopiesASourceDocument(original, copiedTo);
        await Client.NextSnapshot(fx);
        await ItsPluginSourceReadsAs(unreadable: true);

        OtherTool.DeletesTheFile(OtherTool.Beside(original, copiedTo));
        await Client.NextSnapshot(fx);

        await ItsPluginSourceReadsAs(unreadable: false);
        Assert.Equal(Npc, (await Client.Record(npc)).GetProperty("editorId").GetString());
    }

    private Task ItsPluginSourceReadsAs(bool unreadable) =>
        Wire.Eventually(
            async () => (await Client.Plugin(Plugin)).GetProperty("pluginSourceUnreadable").GetBoolean() == unreadable,
            $"{Plugin} reported with its plugin source {(unreadable ? "unreadable" : "read")}");

    private async Task<IReadOnlyList<string>> TheFilesItsReadStoppedAt()
    {
        await ItsPluginSourceReadsAs(unreadable: true);
        IReadOnlyList<string> files = [];
        await Wire.Eventually(async () =>
        {
            var answer = await Client.GetFromJsonAsync<JsonElement>("/plugins/problems");
            files =
            [
                .. answer.EnumerateArray()
                    .Where(p => p.GetProperty("plugin").GetProperty("name").GetString() == Plugin)
                    .SelectMany(p => p.GetProperty("problems").EnumerateArray())
                    .Select(problem => problem.GetProperty("sourceRelativePath").GetString().Require()),
            ];
            return files.Count > 0;
        }, $"the files {Plugin}'s read stopped at");
        return files;
    }

    private async Task TheFrameAfterWhichItReadsGone(StreamReader stream, string formKey)
    {
        while (true)
        {
            var frame = (await stream.EventsUntil("rows-changed", e => Names(e, formKey)))[^1];
            await Client.SequenceReaches(frame.GetProperty("sequence").GetInt64());
            var read = await Client.GetAsync(new Uri($"/records/{Uri.EscapeDataString(formKey)}", UriKind.Relative));
            if (read.StatusCode == HttpStatusCode.NotFound) return;
        }
    }

    [Theory]
    [InlineData("RenamedByHand.json")]
    [InlineData("SortedByHand/{0}")]
    public async Task ACommittedDocumentDeletedThenWrittenElsewhereByHand_BringsItsRecordBack(string writtenTo)
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var npc = await Client.FirstFormKey(Plugin, Origin);
        var original = OtherTool.SourceDocumentCarrying(modFolder, Plugin, Npc);
        var text = File.ReadAllText(original);
        using var stream = await Client.NotificationStream();
        OtherTool.DeletesTheFile(original);
        await Client.NextSnapshot(fx);
        await TheFrameAfterWhichItReadsGone(stream, npc);

        OtherTool.WritesTheFile(OtherTool.Beside(original, writtenTo), text);
        await Client.NextSnapshot(fx);

        await Wire.Eventually(
            async () => (await Client.GetAsync(new Uri($"/records/{Uri.EscapeDataString(npc)}", UriKind.Relative))).IsSuccessStatusCode,
            "the record came back");
        Assert.Equal(Npc, (await Client.Record(npc)).GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task ACommittedContainerCopiedThenDeletedByHandUnderANameWithoutItsFormKey_KeepsItsRecords()
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var cell = await Client.FirstFormKey(Plugin, Origin, "cell");
        var placedRef = await Client.FormKeyNamed(Plugin, Origin, "refr", PlacedRef);
        var original = Path.GetDirectoryName(OtherTool.SourceDocumentCarrying(modFolder, Plugin, Cell)).Require();
        OtherTool.CopiesASourceDirectory(original, "RenamedByHand");
        await Client.NextSnapshot(fx);
        await ItsPluginSourceReadsAs(unreadable: true);

        OtherTool.DeletesTheDirectory(original);
        await Client.NextSnapshot(fx);

        await ItsPluginSourceReadsAs(unreadable: false);
        Assert.Equal(Cell, (await Client.Record(cell)).GetProperty("editorId").GetString());
        Assert.Equal(PlacedRef, (await Client.Record(placedRef)).GetProperty("editorId").GetString());
    }

    [Theory]
    [InlineData(Cell, "cell")]
    [InlineData(World, "wrld")]
    public async Task ACommittedContainerDeletedThenWrittenByHandUnderANameWithoutItsFormKey_BringsItsRecordBack(
        string editorId, string recordType)
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var container = await Client.FirstFormKey(Plugin, Origin, recordType);
        var document = OtherTool.SourceDocumentCarrying(modFolder, Plugin, $"\"{editorId}\"");
        var original = Path.GetDirectoryName(document).Require();
        var text = File.ReadAllText(document);
        using var stream = await Client.NotificationStream();
        OtherTool.DeletesTheDirectory(original);
        await Client.NextSnapshot(fx);
        await stream.EventsUntil("rows-changed", e => Names(e, container));

        OtherTool.WritesTheFile(
            Path.Combine(OtherTool.Beside(original, "RenamedByHand"), Path.GetFileName(document)), text);
        await Client.NextSnapshot(fx);

        await stream.EventsUntil("rows-changed", e => Names(e, container));
        Assert.Equal(editorId, (await Client.Record(container)).GetProperty("editorId").GetString());
    }

    [Theory]
    [InlineData(Cell, "cell")]
    [InlineData(World, "wrld")]
    public async Task AContainerWhoseDirectoryWasRenamedByHand_TakesAnEdit(string editorId, string recordType)
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var container = await Client.FirstFormKey(Plugin, Origin, recordType);
        var directory = Path.GetDirectoryName(OtherTool.SourceDocumentCarrying(modFolder, Plugin, $"\"{editorId}\"")).Require();
        Directory.Move(directory, OtherTool.Beside(directory, "RenamedByHand"));

        (await Client.Edit(container, Plugin, Origin, "EditorID", "EditedAfterTheRename")).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);

        await Wire.Eventually(
            async () => (await Client.Record(container)).GetProperty("editorId").GetString() == "EditedAfterTheRename",
            "the edit reached the read");
    }

    [Fact]
    public async Task ARecordInAFolderMovedInWholeByHand_IsRead()
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var npc = await Client.FirstFormKey(Plugin, Origin);
        var original = OtherTool.SourceDocumentCarrying(modFolder, Plugin, Npc);
        const string added = "000900:Shared.esp";
        var text = File.ReadAllText(original)
            .Replace(npc, added, StringComparison.Ordinal)
            .Replace(Npc, "AddedNpc", StringComparison.Ordinal);
        OtherTool.MovesInAFolderHolding(OtherTool.Beside(original, "AddedByHand"), "AddedNpc - 000900_Shared.esp.json", text);
        await Client.NextSnapshot(fx);

        await Wire.Eventually(
            async () => (await Client.GetAsync(new Uri($"/records/{Uri.EscapeDataString(added)}", UriKind.Relative))).IsSuccessStatusCode,
            "the record in the folder was read");
        Assert.Equal("AddedNpc", (await Client.Record(added)).GetProperty("editorId").GetString());
    }

    private async Task<List<(string Kind, JsonElement Data)>> FramesOfTheSnapshotAnchoredBy(
        ScatteredFixtureData fx, StreamReader stream, string modFolder, string quest)
    {
        OtherTool.EditsASourceDocument(modFolder, Plugin, "SettledFilter", "AnchorFilter");
        await Client.NextSnapshot(fx);
        var frames = new List<(string Kind, JsonElement Data)>(
            await stream.FramesThrough("rows-changed", e => Names(e, quest)));
        OtherTool.EditsASourceDocument(modFolder, Plugin, "AnchorFilter", "BoundingFilter");
        await Client.NextSnapshot(fx);
        frames.AddRange(await stream.FramesThrough("rows-changed", e => Names(e, quest)));
        return frames;
    }

    private static bool Names(JsonElement rowsChanged, string formKey) =>
        rowsChanged.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey);

    [Fact]
    public async Task ARewriteOfAnUntrackedPluginsBytes_PushesPluginChanged_AndTheNextReadAgrees()
    {
        using var fx = new PluginFixtureBuilder("trace-another-tool-untracked")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        using var stream = await Client.NotificationStream();

        OtherTool.WritesThePlugin(
            fx.Plugins.Single(p => p.Origin == Origin).Path, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.9f);
        await Client.NextSnapshot(fx);

        var changed = await stream.EventsUntil("plugin-changed", e => e.GetProperty("plugin").GetString() == Plugin);
        Assert.Equal(Origin, changed[^1].GetProperty("origin").GetString());
        await Client.SequenceReaches(changed[^1].GetProperty("sequence").GetInt64());
        Assert.Equal(0.9, (await Field(formKey, "HeightMax")).GetDouble(), 3);
    }

    [Fact]
    public async Task AGitRevertOfAQuestsDocument_ReachesTheNextRead()
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var quest = await Client.FirstFormKey(Plugin, Origin, "qust");
        (await Client.Edit(quest, Plugin, Origin, "Filter", "EditedFilter")).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Wire.Eventually(async () => (await Field(quest, "Filter")).GetString() == "EditedFilter", "the edit reached the read");

        OtherTool.RevertsASourceDocument(modFolder, Plugin, "EditedFilter");
        await Client.NextSnapshot(fx);

        await Wire.Eventually(async () => (await Field(quest, "Filter")).GetString() == "OriginalFilter", "the revert reached the read");
    }

    [Fact]
    public async Task AGitRevertOfAPlacedRefsOwningCellDocument_ReachesTheNextRead()
    {
        using var fx = await ATrackedMod();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var placedRef = await Client.FormKeyNamed(Plugin, Origin, "refr", PlacedRef);
        (await Client.Edit(placedRef, Plugin, Origin, "Scale", 2.5)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Wire.Eventually(async () => (await Field(placedRef, "Scale")).GetSingle() == 2.5f, "the edit reached the read");

        OtherTool.RevertsASourceDocument(modFolder, Plugin, "2.5");
        await Client.NextSnapshot(fx);

        await Wire.Eventually(async () => (await Field(placedRef, "Scale")).GetSingle() == 1f, "the revert reached the read");
    }
}
