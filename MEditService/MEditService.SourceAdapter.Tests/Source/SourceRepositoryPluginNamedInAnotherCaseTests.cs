using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryPluginNamedInAnotherCaseTests : IDisposable
{
    private const string TreeName = "Fixture.esp";
    private const string NpcFormKey = "000800:Fixture.esp";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Fixture.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";
    private const string HeaderBody = "{\n  \"ModKey\": \"Fixture.esp\",\n  \"MutagenObjectType\": \"Fallout4Mod\"\n}";

    private static readonly PluginAddress AsTreeNamesIt = new(TreeName, TestMod.Name);
    private static readonly PluginAddress Recased = new("FIXTURE.ESP", TestMod.Name);

    private static readonly string NpcDocument = Path.Combine(PluginSourceRoot.For(TreeName), "Npcs", "FixtureNpc - 000800_Fixture.esp.json");

    private readonly ScratchDirectory _modFolder = new("medit-another-case-");

    public SourceRepositoryPluginNamedInAnotherCaseTests() =>
        PluginBaselines.Track(_modFolder, [
            new TreeFile(PluginSourceRoot.HeaderDocument(TreeName), Encoding.UTF8.GetBytes(HeaderBody)),
            new TreeFile(NpcDocument, Encoding.UTF8.GetBytes(NpcBody)),
        ]);

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository Repository => SourceRepository.Over(TestMod.In(_modFolder), GameRelease.Fallout4);

    private RegisteredPlugin Registered(PluginAddress plugin) =>
        new(plugin.Name, plugin.Origin, "", TestMod.In(_modFolder), Line: null);

    [Fact]
    public void SourceReads_ATreeItsFolderSpellsInAnotherCase_IsTrue()
    {
        Assert.True(SourceRepository.SourceReads(Registered(Recased)));
    }

    [Fact]
    public void TheTreesDocuments_AreReadForThePluginNamedInAnotherCase()
    {
        Assert.Equal([HeaderBody, NpcBody], TreeDocuments.Of(Repository, Recased).Select(document => document.Body));
    }

    [Fact]
    public void StampsOf_ThePluginNamedInAnotherCase_StampsEachDocumentAndFindsNoneUnreadable()
    {
        var stamps = Repository.StampsOf(Recased);

        Assert.Empty(stamps.Unreadable);
        Assert.Equal(SourceRepository.ContentStamp(NpcBody), stamps.ByFormKey[NpcFormKey]);
    }

    [Fact]
    public void RecordOfFile_ADocumentOfTheTree_IsHeldByThePluginAsTheLoadOrderNamesIt()
    {
        var loadOrder = SnapshotPlugins.Snapshot(_modFolder, null, GameRelease.Fallout4, [
            new LoadOrderEntry(Recased.Name, Path.Combine(_modFolder, Recased.Name), Recased.Origin, Line: 0, Enabled: true, Winning: true),
        ]);

        var answer = new GitSourceAdapter().RecordOfFile(loadOrder, Path.Combine(_modFolder, NpcDocument));

        Assert.Equal(new RecordAt(Recased, NpcFormKey), Assert.IsType<RecordOfFileAnswer.Holds>(answer).Record);
    }

    [Fact]
    public void Put_ForThePluginNamedInAnotherCase_WritesIntoItsTree()
    {
        const string weaponBody = "{\n  \"FormKey\": \"000900:Fixture.esp\",\n  \"EditorID\": \"FixtureWeapon\"\n}";

        Repository.Put(Recased, new SourceDocument("000900:Fixture.esp", "weap", "FixtureWeapon", weaponBody));

        Assert.Contains(weaponBody, TreeDocuments.Of(Repository, AsTreeNamesIt).Select(document => document.Body));
    }

    [Fact]
    public void ChangedSinceLastCommit_ForThePluginNamedInAnotherCase_NamesAnEditToItsTree()
    {
        File.WriteAllText(Path.Combine(_modFolder, NpcDocument), NpcBody.Replace("FixtureNpc", "Edited", StringComparison.Ordinal));

        Assert.Equal(RecordChange.Modified, Repository.ChangedSinceLastCommit(Recased)[NpcFormKey]);
    }

    [Fact]
    public void LastWrittenBinarySha256s_ForThePluginNamedInAnotherCase_IsWhatWasWrittenForItsTree()
    {
        const string sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        Repository.WriteBinary(AsTreeNamesIt, sha256, () => { });

        Assert.Equal([sha256], Repository.LastWrittenBinarySha256s(Recased));
    }

    [CaseSensitiveFact]
    public void SourceReads_TwoTreesWhoseFoldersDifferOnlyInCase_IsFalse()
    {
        Directory.CreateDirectory(PluginSourceRoot.In(_modFolder, Recased.Name));

        Assert.False(SourceRepository.SourceReads(Registered(AsTreeNamesIt)));
    }
}
