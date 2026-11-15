using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryCommittedTextKeptTests : IDisposable
{
    private const string PluginName = "Test.esp";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";
    private const string FirstEdit = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"First\"\n}";
    private const string SecondEdit = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"Second\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, "TestMod");
    private static readonly string NpcRelative = Path.Combine("plugin-source", PluginName, "Npcs", $"FixtureNpc - 000800_{PluginName}.json");

    private readonly ScratchDirectory _modFolder = new("medit-committed-kept-");
    private readonly ScratchDirectory _linkedFolder = new("medit-committed-kept-linked-");
    private readonly FakeTimeProvider _clock = new(TimeProvider.System.GetUtcNow());

    public SourceRepositoryCommittedTextKeptTests()
    {
        PluginBaselines.Init(_modFolder, [new TreeFile(NpcRelative, Encoding.UTF8.GetBytes(NpcBody))]);
        Git("checkout", "-q", "-b", "edited");
        File.WriteAllText(NpcPath, FirstEdit);
        Git("add", "-A");
        Git("commit", "-q", "-m", "Edited");
        Git("checkout", "-q", "main");
    }

    public void Dispose()
    {
        _modFolder.Dispose();
        _linkedFolder.Dispose();
    }

    private string NpcPath => Path.Combine(_modFolder, NpcRelative);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private void PastTheSettleWindow() => _clock.SetUtcNow(TimeProvider.System.GetUtcNow().AddSeconds(3));

    private ISourceRepository Repository(string sourceFolder) =>
        TestAdapters.Source(_clock).OverFolder(TestMod.In(sourceFolder), GameRelease.Fallout4);

    private static IReadOnlyDictionary<string, RecordChange> ChangesIn(ISourceRepository repository, string npcPath) =>
        repository.ChangedSinceLastCommitIn(Plugin, [npcPath], []).Value();

    [Fact]
    public void AWriteToAFileWhoseCommittedTextWasAsked_IsComparedWithoutAskingGitAgain()
    {
        PastTheSettleWindow();
        var repository = Repository(_modFolder);
        File.WriteAllText(NpcPath, FirstEdit);
        ChangesIn(repository, NpcPath);
        File.WriteAllText(NpcPath, SecondEdit);

        var changes = GitOffPath.While(() => ChangesIn(repository, NpcPath));

        Assert.Equal(RecordChange.Modified, Assert.Single(changes).Value);
    }

    [Fact]
    public void AWrittenDocumentWhoseFileKeepsItsStamp_IsComparedInPlaceOfTheFile()
    {
        var written = new WrittenDocument(NpcPath, FirstEdit, WrittenStamp.Of(NpcPath).Require());

        var changes = Repository(_modFolder).ChangedSinceLastCommitIn(Plugin, [NpcPath], [written]).Value();

        Assert.Equal(RecordChange.Modified, Assert.Single(changes).Value);
    }

    [Theory]
    [InlineData("a commit", "add -A;commit -q -m Edited")]
    [InlineData("a checkout", "checkout -q -f edited")]
    [InlineData("a reset", "reset -q --soft edited")]
    [InlineData("a commit after the refs are packed", "pack-refs --all;add -A;commit -q -m Edited")]
    [InlineData("a branch switch and back", "checkout -q -f edited;checkout -q -f main")]
    public void AMoveOfHead_MakesTheTextAtTheNewLastCommitTheKeptOne(string moveName, string commands)
    {
        PastTheSettleWindow();
        var repository = Repository(_modFolder);
        File.WriteAllText(NpcPath, FirstEdit);
        Assert.NotEmpty(ChangesIn(repository, NpcPath));

        foreach (var command in commands.Split(';'))
        {
            Git(command.Split(' '));
            ChangesIn(repository, NpcPath);
        }

        Assert.True(ChangesIn(repository, NpcPath).Count == 0, $"after {moveName}");
    }

    [Fact]
    public void ACommitInTheTickOfTheLastOne_LeavingTheRefFileTheSameSizeAndDate_MakesItsTextTheKeptOne()
    {
        var repository = Repository(_modFolder);
        File.WriteAllText(NpcPath, FirstEdit);
        Assert.NotEmpty(ChangesIn(repository, NpcPath));
        var refFile = Path.Combine(_modFolder, ".git", "refs", "heads", "main");
        var stamped = File.GetLastWriteTimeUtc(refFile);

        Git("add", "-A");
        Git("commit", "-q", "-m", "Edited");
        File.SetLastWriteTimeUtc(refFile, stamped);
        PastTheSettleWindow();

        Assert.Empty(ChangesIn(repository, NpcPath));
    }

    [Fact]
    public void ACommitInALinkedWorktree_MakesItsTextTheKeptOne()
    {
        PastTheSettleWindow();
        var tree = Path.Combine(_linkedFolder, "linkedtree");
        Git("worktree", "add", "-q", "-b", "linked", tree);
        var linkedNpc = Path.Combine(tree, NpcRelative);
        var repository = Repository(tree);
        File.WriteAllText(linkedNpc, FirstEdit);
        Assert.NotEmpty(ChangesIn(repository, linkedNpc));

        var linkedGitDir = Path.Combine(_modFolder, ".git", "worktrees", "linkedtree");
        GitProbe.Run(linkedGitDir, tree, "add", "-A");
        GitProbe.Run(linkedGitDir, tree, "commit", "-q", "-m", "Edited");

        Assert.Empty(ChangesIn(repository, linkedNpc));
    }
}
