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

    private ISourceRepository SourceMod()
    {
        PluginBaselines.Init(
            _modFolder,
            [new TreeFile(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk, Encoding.UTF8.GetBytes(NpcBody))]);
        return TestAdapters.OpenSourceMod(_modFolder, Release);
    }

    private static (string, string, string?, string) Tuple(SourceDocument document) =>
        (document.FormKey, document.RecordType, document.EditorId, document.Body);

    private static readonly string HeaderRelativePath =
        PluginSourceRoot.HeaderDocument(PluginName);

    private const string HeaderBody = "{\n  \"ModKey\": \"Fixture.esp\",\n  \"MutagenObjectType\": \"Fallout4Mod\"\n}";

    private static string HeaderFormKey => PluginHeader.FormKeyFor(ModKey.FromFileName(PluginName));

    private ISourceRepository SourceModWithHeader()
    {
        PluginBaselines.Init(
            _modFolder,
            [new TreeFile(HeaderRelativePath, Encoding.UTF8.GetBytes(HeaderBody)),
             new TreeFile(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk, Encoding.UTF8.GetBytes(NpcBody))]);
        return TestAdapters.OpenSourceMod(_modFolder, Release);
    }

    [Fact]
    public void TheTreesDocuments_HoldThePluginHeaderUnderTheFormKeyPluginHeaderComputes()
    {
        var header = TreeDocuments.Of(SourceModWithHeader(), Plugin).SingleOrDefault(d => d.FormKey == HeaderFormKey);

        Assert.NotNull(header);
        Assert.Equal(PluginHeader.RecordType, header.RecordType);
        Assert.Equal(HeaderBody, header.Body);
    }

    [Fact]
    public void TheTreesDocuments_AreEveryDocumentPut()
    {
        var repository = SourceMod();
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
        var repository = SourceMod();

        repository.Remove(Plugin, new RecordIdentity(NpcFormKey, "npc_", NpcEditorId)).Wrote();

        Assert.Empty(TreeDocuments.Of(repository, Plugin));
    }

    [Fact]
    public void AKeyTheWorkingTreeDeleted_IsNotUsed_ThoughTheLastCommitHoldsIt()
    {
        var repository = SourceMod();
        repository.Remove(Plugin, new RecordIdentity(NpcFormKey, "npc_", NpcEditorId)).Wrote();

        Assert.DoesNotContain(NpcFormKey, repository.FormKeysUsed(Plugin).Value());
    }

    [Fact]
    public void AKeyCreatedSinceTheLastCommit_IsUsed()
    {
        var repository = SourceMod();
        repository.Put(Plugin, new SourceDocument("000900:Fixture.esp", "weap", "Later", LaterBody)).Wrote();

        Assert.Equal(
            [NpcFormKey, "000900:Fixture.esp"],
            repository.FormKeysUsed(Plugin).Value().Order(StringComparer.Ordinal).ToList());
    }

    [Fact]
    public void APluginWithNoSourceOfItsOwn_UsesNoKey()
    {
        Assert.Empty(SourceMod().FormKeysUsed(new PluginAddress("Other.esp", TestMod.Name)).Value());
    }

    [Fact]
    public void GroupMetadataAndAStrayFileDeclaringNoFormKey_UseNoKey_ForADocumentIsWhatDeclaresAFormKeyNotWhereItSits()
    {
        var repository = SourceMod();
        var npcsFolder = Path.Combine(PluginSourceRoot.In(_modFolder, PluginName), "Npcs");
        File.WriteAllText(Path.Combine(npcsFolder, "GroupRecordData.json"), "{\n  \"Type\": \"npc_\"\n}");
        File.WriteAllText(Path.Combine(npcsFolder, "notes.json"), "{\n  \"Note\": \"scratch\"\n}");

        Assert.Equal([NpcFormKey], repository.FormKeysUsed(Plugin).Value().ToList());
    }

    private ISourceRepository SourceModWithNpcDeclaring(string declared)
    {
        var repository = SourceMod();
        var path = Path.Combine(PluginSourceRoot.In(_modFolder, PluginName), "Npcs", Path.GetFileName(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk));
        File.WriteAllText(path, NpcBody.Replace(NpcFormKey, declared));
        return repository;
    }

    [Fact]
    public void TheTreesDocuments_NameARecordByMutagensSpellingOfItsFormKey_ThoughTheTextDelimitsItWithAnUnderscore()
    {
        var repository = SourceModWithNpcDeclaring("000800_Fixture.esp");

        Assert.Equal([NpcFormKey], TreeDocuments.Of(repository, Plugin).Select(d => d.FormKey).ToList());
        Assert.Equal([NpcFormKey], repository.FormKeysUsed(Plugin).Value().ToList());
    }

    [Fact]
    public void TheTreesDocuments_RefuseADocumentWhoseFormKeyMutagenCannotParse_NamingItAndWhatItDeclares()
    {
        var repository = SourceModWithNpcDeclaring("not-a-formkey");

        var refused = Assert.IsType<SourceFailure.Unreadable>(
            repository.ReadDocuments(Plugin, documents => documents.Records.ToList()).Stopped());

        Assert.Equal(NpcRelativePathSpelledBeforeAnyRepositoryExistsToAsk, refused.File?.SourceRelativePath);
        Assert.Contains("declares not-a-formkey, which is no FormKey", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ADocumentWhoseFormKeyMutagenCannotParse_RefusesTheKeysUsed_RatherThanLoseIt()
    {
        var repository = SourceModWithNpcDeclaring("not-a-formkey");

        var refused = Assert.IsType<SourceFailure.Unreadable>(repository.FormKeysUsed(Plugin).Stopped());

        Assert.Contains("declares not-a-formkey, which is no FormKey", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ARecordsDocument_SpellingThePluginInAnotherCase_IsTheRecordTheKeyNames()
    {
        var repository = SourceModWithNpcDeclaring("000800:fixture.esp");

        AssertIsTheNpc(repository.RecordByFormKey(Plugin, NpcFormKey).Value());
    }

    private static void AssertIsTheNpc(SourceDocument? found)
    {
        Assert.Equal(NpcFormKey, found?.FormKey, ignoreCase: true);
        Assert.Equal(("npc_", NpcEditorId), (found?.RecordType, found?.EditorId));
    }

    [Fact]
    public void TheTextGivenForARecord_SpellingThePluginInAnotherCase_IsTheRecordTheKeyNames()
    {
        var repository = SourceMod();

        var found = repository.RecordFromText(Plugin, NpcFormKey, NpcBody.Replace(NpcFormKey, "000800:fixture.esp")).Value();

        AssertIsTheNpc(found);
    }

    [Fact]
    public void TwoDocumentsDeclaringOneFormKey_WithThePluginInDifferentCase_AreRefusedAsAClaimOfBoth()
    {
        var repository = SourceMod();
        var npcsFolder = Path.Combine(PluginSourceRoot.In(_modFolder, PluginName), "Npcs");
        File.WriteAllText(Path.Combine(npcsFolder, "Twin.json"), NpcBody.Replace(NpcFormKey, "000800:fixture.esp"));

        var refused = Assert.IsType<SourceFailure.Ambiguous>(
            repository.ReadDocuments(Plugin, documents => documents.Records.ToList()).Stopped());

        Assert.Equal(2, refused.Claim?.Documents.Count);
        Assert.StartsWith("More than one document in this plugin's source tree holds", refused.Reason, StringComparison.Ordinal);
    }
}
