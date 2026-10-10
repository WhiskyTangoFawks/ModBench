using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryTreeDocumentsTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string NpcFormKey = "000800:Fixture.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Fixture.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";

    private const string EditedBody = "{\n  \"FormKey\": \"000800:Fixture.esp\",\n  \"EditorID\": \"EditedSinceCompile\"\n}";
    private const string LaterBody = "{\n  \"FormKey\": \"000900:Fixture.esp\",\n  \"EditorID\": \"Later\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ScratchDirectory _modFolder = new("medit-tree-documents-");

    public void Dispose() => _modFolder.Dispose();

    private static readonly string NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk =
        Path.Combine("plugin-source", PluginName, "Npcs", $"{NpcEditorId} - 000800_{PluginName}.json");

    private ISourceRepository Tracked()
    {
        PluginBaselines.Track(
            _modFolder,
            [new TreeFile(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk, Encoding.UTF8.GetBytes(NpcBody))]);
        return TestAdapters.Source().Open(TestMod.In(_modFolder), Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    private static (string, string, string?, string) Tuple(SourceDocument document) =>
        (document.FormKey, document.RecordType, document.EditorId, document.Body);

    private static readonly string HeaderRelativePath =
        PluginSourceRoot.HeaderDocument(PluginName);

    private const string HeaderBody = "{\n  \"ModKey\": \"Fixture.esp\",\n  \"MutagenObjectType\": \"Fallout4Mod\"\n}";

    private static string HeaderFormKey => PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

    private ISourceRepository TrackedWithHeader()
    {
        PluginBaselines.Track(
            _modFolder,
            [new TreeFile(HeaderRelativePath, Encoding.UTF8.GetBytes(HeaderBody)),
             new TreeFile(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk, Encoding.UTF8.GetBytes(NpcBody))]);
        return TestAdapters.Source().Open(TestMod.In(_modFolder), Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");
    }

    [Fact]
    public void TheTreesDocuments_HoldThePluginHeaderUnderTheFormKeyPluginHeaderComputes()
    {
        var header = TreeDocuments.Of(TrackedWithHeader(), Plugin).SingleOrDefault(d => d.FormKey == HeaderFormKey);

        Assert.NotNull(header);
        Assert.Equal(PluginHeader.RecordType, header.RecordType);
        Assert.Equal(HeaderBody, header.Body);
    }

    [Fact]
    public void TheTreesDocuments_AreEveryDocumentPut()
    {
        var repository = Tracked();
        var weapon = new SourceDocument("000900:Fixture.esp", "weap", "FixtureWeapon",
            "{\n  \"FormKey\": \"000900:Fixture.esp\",\n  \"EditorID\": \"FixtureWeapon\"\n}");
        var race = new SourceDocument("000A00:Fixture.esp", "race", null,
            "{\n  \"FormKey\": \"000A00:Fixture.esp\"\n}");
        repository.Put(Plugin, weapon).Wrote();
        repository.Put(Plugin, race).Wrote();

        var read = TreeDocuments.Of(repository, Plugin);

        Assert.Equal(
            [(NpcFormKey, "npc_", NpcEditorId, NpcBody), Tuple(weapon), Tuple(race)],
            read.Select(Tuple).OrderBy(t => t.Item1, StringComparer.Ordinal).ToList());
    }

    [Fact]
    public void TheTreesDocuments_DropARecordRemoved()
    {
        var repository = Tracked();

        repository.Remove(Plugin, new RecordIdentity(NpcFormKey, "npc_", NpcEditorId)).Wrote();

        Assert.Empty(TreeDocuments.Of(repository, Plugin));
    }

    [Fact]
    public void FormKeysUsed_AKeyTheWorkingTreeDeleted_IsNotUsed_ThoughTheLastCommitHoldsIt()
    {
        var repository = Tracked();
        repository.Remove(Plugin, new RecordIdentity(NpcFormKey, "npc_", NpcEditorId)).Wrote();

        Assert.DoesNotContain(NpcFormKey, repository.FormKeysUsed(Plugin).Value());
    }

    [Fact]
    public void FormKeysUsed_AKeyCreatedSinceTheLastCommit_IsUsed()
    {
        var repository = Tracked();
        repository.Put(Plugin, new SourceDocument("000900:Fixture.esp", "weap", "Later", LaterBody)).Wrote();

        Assert.Equal(
            [NpcFormKey, "000900:Fixture.esp"],
            repository.FormKeysUsed(Plugin).Value().Order(StringComparer.Ordinal).ToList());
    }

    [Fact]
    public void FormKeysUsed_APluginWithNoSourceOfItsOwn_IsEmpty()
    {
        Assert.Empty(Tracked().FormKeysUsed(new PluginAddress("Other.esp", TestMod.Name)).Value());
    }

    [Fact]
    public void FormKeysUsed_SkipsGroupMetadataAndAStrayFileDeclaringNoFormKey_ForADocumentIsWhatDeclaresAFormKeyNotWhereItSits()
    {
        var repository = Tracked();
        var npcsFolder = Path.Combine(PluginSourceRoot.In(_modFolder, PluginName), "Npcs");
        File.WriteAllText(Path.Combine(npcsFolder, "GroupRecordData.json"), "{\n  \"Type\": \"npc_\"\n}");
        File.WriteAllText(Path.Combine(npcsFolder, "notes.json"), "{\n  \"Note\": \"scratch\"\n}");

        Assert.Equal([NpcFormKey], repository.FormKeysUsed(Plugin).Value().ToList());
    }
}
