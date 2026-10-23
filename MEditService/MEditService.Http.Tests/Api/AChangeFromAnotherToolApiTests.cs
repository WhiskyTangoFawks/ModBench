using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
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

    private async Task<ScatteredFixtureData> ASourceMod()
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
        Assert.Contains(Path.GetRelativePath(modFolder, OtherTool.Beside(original, "Backup/{0}")), detail, StringComparison.Ordinal);
        Assert.Equal(Npc, (await Client.Record(npc)).GetProperty("editorId").GetString());
        await Client.NextSnapshot(fx);
        await ItsPluginSourceReadsAs(unreadable: true);
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
        using var fx = await ASourceMod();
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
        using var fx = await ASourceMod();
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
        using var fx = await ASourceMod();
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

    private Task ItsPluginSourceReadsAs(bool unreadable) =>
        Wire.Eventually(
            async () => (await Client.Plugin(Plugin)).GetProperty("pluginSourceUnreadable").ValueKind != JsonValueKind.Null == unreadable,
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
        using var fx = await ASourceMod();
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
        using var fx = await ASourceMod();
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
        using var fx = await ASourceMod();
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

    private static bool Names(JsonElement rowsChanged, string formKey) =>
        rowsChanged.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey);
}
