using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>What git names as changed in a plugin's tree since a validated HEAD: the dirty documents
/// and the ones a moved HEAD changed, each by the record it declares (ADR-0009).</summary>
public sealed class SourceRepositoryChangesSinceTests : IDisposable
{
    private const string PluginName = "Test.esp";
    private const string NpcFormKey = "000800:Test.esp";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";
    private const string EditedBody = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"Edited\"\n}";
    private const string OtherBody = "{\n  \"FormKey\": \"000900:Test.esp\",\n  \"EditorID\": \"OtherNpc\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, "TestMod");

    private static readonly string NpcRelativePath =
        Path.Combine("plugin-source", PluginName, "Npcs", $"FixtureNpc - 000800_{PluginName}.json");
    private static readonly string OtherRelativePath =
        Path.Combine("plugin-source", PluginName, "Npcs", $"OtherNpc - 000900_{PluginName}.json");

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-changes-since-").FullName;
    private readonly SourceRepository _repository;
    private readonly string _validatedHead;

    public SourceRepositoryChangesSinceTests()
    {
        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits,
            [new TreeFile(NpcRelativePath, Encoding.UTF8.GetBytes(NpcBody)),
             new TreeFile(OtherRelativePath, Encoding.UTF8.GetBytes(OtherBody))]);
        _repository = SourceRepository.Over(_modFolder, GameRelease.Fallout4);
        _validatedHead = _repository.ChangesSince(Plugin, validatedHead: null).Head.Require();
    }

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private string FullPath(string relativePath) => Path.Combine(_modFolder, relativePath);

    private static string GitPath(string relativePath) => relativePath.Replace('\\', '/');

    private IReadOnlyList<ChangedDocument> Named() =>
        _repository.ChangesSince(Plugin, _validatedHead).Documents
            ?? throw new InvalidOperationException("Expected git to narrow the documents.");

    [Fact]
    public void NoValidatedHead_NarrowsNothing()
    {
        var changes = _repository.ChangesSince(Plugin, validatedHead: null);

        Assert.Null(changes.Documents);
        Assert.Equal(Git("rev-parse", "HEAD").Trim(), changes.Head);
    }

    [Fact]
    public void ACleanTreeAtTheValidatedHead_NamesNothing() => Assert.Empty(Named());

    [Fact]
    public void AnUnstagedEdit_IsNamedWithItsText()
    {
        File.WriteAllText(FullPath(NpcRelativePath), EditedBody);

        var only = Assert.Single(Named());

        Assert.Equal(NpcFormKey, only.FormKey);
        Assert.Equal(EditedBody, only.WorkingTreeText);
        Assert.False(only.NewPath);
    }

    [Fact]
    public void AWorkingTreeDeletion_IsNamedWithNoText()
    {
        File.Delete(FullPath(NpcRelativePath));

        var only = Assert.Single(Named());

        Assert.Equal(NpcFormKey, only.FormKey);
        Assert.Null(only.WorkingTreeText);
    }

    [Fact]
    public void ADocumentNoRefHolds_IsANewPath()
    {
        var created = Path.Combine("plugin-source", PluginName, "Npcs", $"Created - 000A00_{PluginName}.json");
        File.WriteAllText(FullPath(created), "{\"FormKey\":\"000A00:Test.esp\",\"EditorID\":\"Created\"}");

        var only = Assert.Single(Named());

        Assert.Equal("000A00:Test.esp", only.FormKey);
        Assert.True(only.NewPath);
    }

    // The rival: status alone, which reports a tree the commit left clean.
    [Fact]
    public void ACommitSinceTheValidatedHead_NamesWhatItChanged_ThoughTheTreeIsClean()
    {
        File.WriteAllText(FullPath(NpcRelativePath), EditedBody);
        Git("commit", "-q", "-am", "an edit committed outside Modbench");

        var changes = _repository.ChangesSince(Plugin, _validatedHead);

        var only = Assert.Single(changes.Documents.Require());
        Assert.Equal(NpcFormKey, only.FormKey);
        Assert.Equal(EditedBody, only.WorkingTreeText);
        Assert.Equal(Git("rev-parse", "HEAD").Trim(), changes.Head);
    }

    // Removed from the commit and still in the working tree: the path was HEAD's at the validated
    // HEAD, so it is no new path though git calls it untracked now.
    [Fact]
    public void ADocumentCommittedOutOfHead_IsNotANewPath()
    {
        Git("rm", "-q", "--cached", GitPath(NpcRelativePath));
        Git("commit", "-q", "-m", "removed from the committed tree outside Modbench");

        var only = Assert.Single(Named());

        Assert.Equal(NpcFormKey, only.FormKey);
        Assert.False(only.NewPath);
    }

    // --no-renames: a staged move names the document it left as well as the one it made.
    [Fact]
    public void AStagedRename_NamesBothPaths()
    {
        var renamed = Path.Combine("plugin-source", PluginName, "Npcs", $"Renamed - 000800_{PluginName}.json");
        Git("mv", GitPath(NpcRelativePath), GitPath(renamed));

        var named = Named();

        Assert.Equal(2, named.Count);
        Assert.All(named, d => Assert.Equal(NpcFormKey, d.FormKey));
        Assert.Contains(named, d => d.WorkingTreeText == null);
        Assert.Contains(named, d => d.WorkingTreeText == NpcBody && d.NewPath);
    }

    [Fact]
    public void AValidatedHeadGitNoLongerHas_NarrowsNothing()
    {
        var changes = _repository.ChangesSince(Plugin, new string('0', 40));

        Assert.Null(changes.Documents);
    }

    [Fact]
    public void AnUnreadableHead_NarrowsNothingAndNamesNoHead()
    {
        Git("symbolic-ref", "HEAD", "refs/heads/no-such-branch");

        var changes = _repository.ChangesSince(Plugin, _validatedHead);

        Assert.Null(changes.Head);
        Assert.Null(changes.Documents);
    }

    // A path the whole-tree read counts as a document but whose text declares no record.
    [Fact]
    public void ADocumentDeclaringNoFormKey_NarrowsNothing()
    {
        File.WriteAllText(FullPath(NpcRelativePath), "{\"EditorID\":\"Nameless\"}");

        Assert.Null(_repository.ChangesSince(Plugin, _validatedHead).Documents);
    }

    // A copy under a name that does not carry its FormKey: the tree's other document for it is one
    // git does not name, so only a whole-tree read can see the two.
    [Fact]
    public void ADocumentWhoseNameDoesNotCarryItsFormKey_NarrowsNothing()
    {
        File.WriteAllText(FullPath(Path.Combine("plugin-source", PluginName, "Npcs", "Copy of FixtureNpc.json")), NpcBody);

        Assert.Null(_repository.ChangesSince(Plugin, _validatedHead).Documents);
    }

    [Fact]
    public void TwoNamedDocumentsDeclaringOneFormKey_AreAmbiguous()
    {
        File.WriteAllText(FullPath(Path.Combine("plugin-source", PluginName, "Npcs", $"Twin - 000800_{PluginName}.json")), NpcBody);
        File.WriteAllText(FullPath(NpcRelativePath), EditedBody);

        Assert.Throws<AmbiguousSourceUnitException>(() => _repository.ChangesSince(Plugin, _validatedHead));
    }

    // Untracked files under an untracked folder: -uall lists each, where git would name the folder.
    [Fact]
    public void ADocumentInANewFolder_IsNamedByItsOwnPath()
    {
        var sorted = Path.Combine("plugin-source", PluginName, "Npcs", "Sorted", $"Sorted - 000A00_{PluginName}.json");
        Directory.CreateDirectory(Path.GetDirectoryName(FullPath(sorted)).Require());
        File.WriteAllText(FullPath(sorted), "{\"FormKey\":\"000A00:Test.esp\",\"EditorID\":\"Sorted\"}");

        Assert.Equal("000A00:Test.esp", Assert.Single(Named()).FormKey);
    }

    // The whole-tree read counts an ignored document, so git has to name it too.
    [Fact]
    public void AnIgnoredDocument_IsNamed()
    {
        var ignored = Path.Combine("plugin-source", PluginName, "Npcs", $"Ignored - 000A00_{PluginName}.json");
        File.WriteAllText(FullPath(Path.Combine("plugin-source", PluginName, "Npcs", ".gitignore")), "Ignored - *\n");
        File.WriteAllText(FullPath(ignored), "{\"FormKey\":\"000A00:Test.esp\",\"EditorID\":\"Ignored\"}");

        Assert.Equal("000A00:Test.esp", Assert.Single(Named()).FormKey);
    }

    [Fact]
    public void AChangeOutsideThePluginsTree_IsNotNamed()
    {
        var elsewhere = Path.Combine("plugin-source", "Other.esp", "Npcs", "Elsewhere - 000800_Other.esp.json");
        Directory.CreateDirectory(Path.GetDirectoryName(FullPath(elsewhere)).Require());
        File.WriteAllText(FullPath(elsewhere), "{\"FormKey\":\"000800:Other.esp\"}");
        File.WriteAllText(FullPath("readme.txt"), "notes");

        Assert.Empty(Named());
    }
}
