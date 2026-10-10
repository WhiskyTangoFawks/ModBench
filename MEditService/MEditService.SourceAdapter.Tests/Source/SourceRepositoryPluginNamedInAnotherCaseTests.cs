using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Noggog;

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

    [PosixFact]
    public void SourceReads_APluginSourceThatCannotBeListed_IsFalseNotAThrow()
    {
        var sources = Path.Combine(_modFolder, "plugin-source");
        FileModes.Set(sources, "000");
        try
        {
            Assert.False(SourceRepository.SourceReads(Registered(AsTreeNamesIt)));
        }
        finally
        {
            FileModes.Set(sources, "700");
        }
    }

    [Fact]
    public void SourceReads_APluginSourceThatIsAFile_IsFalseNotAThrow()
    {
        var sources = Path.Combine(_modFolder, "plugin-source");
        Directory.Delete(sources, recursive: true);
        File.WriteAllText(sources, "");

        Assert.False(SourceRepository.SourceReads(Registered(AsTreeNamesIt)));
    }

    [Fact]
    public void ReadDocuments_ForThePluginNamedInAnotherCase_ReadsEachDocumentOfItsTree()
    {
        Assert.Equal([HeaderBody, NpcBody], TreeDocuments.Of(Repository, Recased).Select(document => document.Body));
    }

    [Fact]
    public void StampsOf_ForThePluginNamedInAnotherCase_StampsEachDocumentAndFindsNoneUnreadable()
    {
        var stamps = Repository.StampsOf(Recased);

        Assert.Empty(stamps.Unreadable);
        Assert.Equal(SourceRepository.ContentStamp(NpcBody), stamps.ByFormKey[NpcFormKey]);
    }

    [Fact]
    public void RecordOfFile_ADocumentOfTheTree_IsHeldByThePluginAsTheLoadOrderNamesIt()
    {
        var answer = new GitSourceAdapter(new UnsavedDocuments()).RecordOfFile(LoadOrderNaming(Recased), Path.Combine(_modFolder, NpcDocument));

        Assert.Equal(new RecordAt(Recased, NpcFormKey), Assert.IsType<RecordOfFileAnswer.Holds>(answer).Record);
    }

    [Fact]
    public void Put_ForThePluginNamedInAnotherCase_WritesIntoItsTree()
    {
        const string weaponBody = "{\n  \"FormKey\": \"000900:Fixture.esp\",\n  \"EditorID\": \"FixtureWeapon\"\n}";

        Repository.Put(Recased, new SourceDocument("000900:Fixture.esp", "weap", "FixtureWeapon", weaponBody)).Wrote();

        Assert.Contains(weaponBody, TreeDocuments.Of(Repository, AsTreeNamesIt).Select(document => document.Body));
    }

    [Fact]
    public void ReplaceSourceFrom_ForThePluginNamedInAnotherCase_ReplacesItsTree()
    {
        const string decompiledHeader = "{\n  \"ModKey\": \"FIXTURE.ESP\"\n}";

        Repository.ReplaceSourceFrom(Recased, [new TreeFile("RecordData.json", Encoding.UTF8.GetBytes(decompiledHeader))], "ABCDEF0123").Wrote();

        Assert.Equal([decompiledHeader], TreeDocuments.Of(Repository, AsTreeNamesIt).Select(document => document.Body));
    }

    [Fact]
    public void ChangesToRenameSource_ForThePluginNamedInAnotherCase_MoveItsTree()
    {
        var renamed = new PluginAddress("Renamed.esp", TestMod.Name);

        var changes = Repository.ChangesToRenameSource(Recased, renamed.Name).Value().Require();
        Repository.SaveChanges(SourceAnswer.Of(changes)).Wrote();

        Assert.Equal(2, TreeDocuments.Of(Repository, renamed).Count);
        Assert.False(SourceRepository.SourceReads(Registered(AsTreeNamesIt)));
    }

    [Fact]
    public void ChangedSinceLastCommit_ForThePluginNamedInAnotherCase_NamesAnEditToItsTree()
    {
        File.WriteAllText(Path.Combine(_modFolder, NpcDocument), NpcBody.Replace("FixtureNpc", "Edited", StringComparison.Ordinal));

        Assert.Equal(RecordChange.Modified, Repository.ChangedSinceLastCommit(Recased).Value()[NpcFormKey]);
    }

    [Fact]
    public void LastWrittenBinarySha256s_ForThePluginNamedInAnotherCase_IsWhatWasWrittenForItsTree()
    {
        const string sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        Repository.WriteBinary(AsTreeNamesIt, sha256, () => { }).Value();

        Assert.Equal([sha256], Repository.LastWrittenBinarySha256s(Recased).Value());
    }

    [Fact]
    public void MoveLastWrittenTo_TheTreeNameTheRenameAnswered_MovesWhatWasWrittenUnderTheTreesSpelling()
    {
        const string sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        Repository.WriteBinary(AsTreeNamesIt, sha256, () => { }).Value();
        var renamed = new PluginAddress("Renamed.esp", TestMod.Name);
        var treeName = Repository.TreeNameOf(Recased);
        var changes = Repository.ChangesToRenameSource(Recased, renamed.Name).Value().Require();
        Repository.SaveChanges(SourceAnswer.Of(changes)).Wrote();

        Assert.Null(Repository.MoveLastWrittenTo(treeName, renamed.Name));

        Assert.Equal(TreeName, treeName);
        Assert.Equal([sha256], Repository.LastWrittenBinarySha256s(renamed).Value());
        Assert.Empty(Repository.LastWrittenBinarySha256s(AsTreeNamesIt).Value());
    }

    [PosixFact]
    public void ReadDocuments_ForAPluginWithTwinTreesOneSpelledAsTheLoadOrderNamesIt_ReadsThatOne()
    {
        MakeTwinOfTheTreeIn(Recased.Name);

        Assert.True(SourceRepository.SourceReads(Registered(AsTreeNamesIt)));
        Assert.Equal([HeaderBody, NpcBody], TreeDocuments.Of(Repository, AsTreeNamesIt).Select(document => document.Body));
    }

    [PosixFact]
    public void SourceReads_ForAPluginWithTwinTreesNeitherSpelledAsTheLoadOrderNamesIt_IsFalse()
    {
        MakeTwinOfTheTreeIn(Recased.Name);

        Assert.False(SourceRepository.SourceReads(Registered(new PluginAddress("fixture.esp", TestMod.Name))));
    }

    [PosixFact]
    public void WhySourceDoesNotRead_ForTwinTreesNeitherSpelledAsTheLoadOrderNamesIt_NamesBothFolders()
    {
        MakeTwinOfTheTreeIn(Recased.Name);

        var why = Assert.IsType<SourceFailure.TwinFolders>(
            new GitSourceAdapter(new UnsavedDocuments()).WhySourceDoesNotRead(Registered(new PluginAddress("fixture.esp", TestMod.Name))));

        Assert.Contains(TreeName, why.Reason, StringComparison.Ordinal);
        Assert.Contains(Recased.Name, why.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void WhySourceDoesNotRead_ForAPluginWithNoFolder_SaysSo()
    {
        var why = new GitSourceAdapter(new UnsavedDocuments()).WhySourceDoesNotRead(Registered(new PluginAddress("Other.esp", TestMod.Name)));

        var missing = Assert.IsType<SourceFailure.NotCarried>(why);
        Assert.Contains("Other.esp", missing.Reason, StringComparison.Ordinal);
        Assert.True(missing.DecompileRepairs);
    }

    [PosixFact]
    public void WhySourceDoesNotRead_ForAPluginSourceThatCannotBeListed_SaysWhyTheSystemGave()
    {
        var sources = Path.Combine(_modFolder, "plugin-source");
        FileModes.Set(sources, "000");
        try
        {
            var why = Assert.IsType<SourceFailure.Inaccessible>(new GitSourceAdapter(new UnsavedDocuments()).WhySourceDoesNotRead(Registered(AsTreeNamesIt)));
            Assert.Contains("plugin-source", why.Reason, StringComparison.Ordinal);
            Assert.False(why.DecompileRepairs);
        }
        finally
        {
            FileModes.Set(sources, "700");
        }
    }

    [Fact]
    public void WhySourceDoesNotRead_ForATreeThatReads_IsNull()
    {
        Assert.Null(new GitSourceAdapter(new UnsavedDocuments()).WhySourceDoesNotRead(Registered(Recased)));
    }

    [PosixFact]
    public void ReplaceSourceFrom_ForTwinTreesNeitherSpelledAsTheLoadOrderNamesIt_AnswersAmbiguousNamingBoth_AndWritesNoThirdFolder()
    {
        MakeTwinOfTheTreeIn(Recased.Name);
        var lowered = new PluginAddress("fixture.esp", TestMod.Name);

        var failure = Repository.ReplaceSourceFrom(lowered, [new TreeFile("RecordData.json", Encoding.UTF8.GetBytes("{}"))], "ABCDEF0123");

        var ambiguous = Assert.IsType<SourceFailure.TwinFolders>(failure);
        Assert.False(ambiguous.DecompileRepairs);
        Assert.Contains(TreeName, ambiguous.Reason, StringComparison.Ordinal);
        Assert.Contains(Recased.Name, ambiguous.Reason, StringComparison.Ordinal);
        Assert.Equal(
            [Recased.Name, TreeName],
            Directory.GetDirectories(Path.Combine(_modFolder, "plugin-source")).Select(Path.GetFileName).Order(StringComparer.Ordinal));
    }

    [PosixFact]
    public void RecordOfFile_ADocumentOfATwinTreeThePluginDoesNotRead_IsRefused()
    {
        MakeTwinOfTheTreeIn(Recased.Name);

        var answer = new GitSourceAdapter(new UnsavedDocuments()).RecordOfFile(LoadOrderNaming(AsTreeNamesIt), TwinNpcDocument(Recased.Name));

        Assert.IsType<RecordOfFileAnswer.Refused>(answer);
    }

    private LoadOrderSnapshot LoadOrderNaming(PluginAddress plugin) =>
        SnapshotPlugins.Snapshot(_modFolder, null, GameRelease.Fallout4, [
            new LoadOrderEntry(plugin.Name, Path.Combine(_modFolder, plugin.Name), plugin.Origin, Line: 0, Enabled: true, Winning: true),
        ]);

    private string TwinNpcDocument(string twinName) =>
        Path.Combine(PluginSourceRoot.In(_modFolder, twinName), "Npcs", "TwinNpc - 000801_Fixture.esp.json");

    private void MakeTwinOfTheTreeIn(string twinName)
    {
        var twinNpc = TwinNpcDocument(twinName);
        Directory.CreateDirectory(Path.GetDirectoryName(twinNpc).Require());
        File.WriteAllText(twinNpc, "{\n  \"FormKey\": \"000801:Fixture.esp\",\n  \"EditorID\": \"TwinNpc\"\n}");
    }
}
