using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryCommittedTextKeptTests : IDisposable
{
    private const string PluginName = "Test.esp";
    private const string NpcFormKey = "000800:Test.esp";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";
    private const string FirstEdit = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"First\"\n}";
    private const string SecondEdit = "{\n  \"FormKey\": \"000800:Test.esp\",\n  \"EditorID\": \"Second\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, "TestMod");

    private readonly ScratchDirectory _modFolder = new("medit-committed-kept-");
    private readonly string _npcPath;
    private readonly ISourceRepository _repository;

    public SourceRepositoryCommittedTextKeptTests()
    {
        var relative = Path.Combine("plugin-source", PluginName, "Npcs", $"FixtureNpc - 000800_{PluginName}.json");
        PluginBaselines.Init(_modFolder, [new TreeFile(relative, Encoding.UTF8.GetBytes(NpcBody))]);
        _repository = TestAdapters.OpenSourceMod(_modFolder, GameRelease.Fallout4);
        _npcPath = Path.Combine(_modFolder, relative);
    }

    public void Dispose() => _modFolder.Dispose();

    private IReadOnlyDictionary<string, RecordChange> ChangesIn() => _repository.ChangedSinceLastCommitIn(Plugin, [_npcPath]).Value();

    [Fact]
    public void AWriteToAFileWhoseCommittedTextWasAsked_IsComparedWithoutAskingGitAgain()
    {
        File.WriteAllText(_npcPath, FirstEdit);
        ChangesIn();
        File.WriteAllText(_npcPath, SecondEdit);

        var changes = GitOffPath.While(ChangesIn);

        Assert.Equal(RecordChange.Modified, Assert.Single(changes).Value);
    }

    [Fact]
    public void AWriteBackToTheCommittedText_ClearsTheChange_WithoutAskingGit()
    {
        File.WriteAllText(_npcPath, FirstEdit);
        ChangesIn();
        File.WriteAllText(_npcPath, NpcBody);

        Assert.Empty(GitOffPath.While(ChangesIn));
    }

    [Fact]
    public void ACommitMovingTheLastCommit_MakesTheCommittedTextTheNewOne()
    {
        File.WriteAllText(_npcPath, FirstEdit);
        Assert.Equal(NpcFormKey, Assert.Single(ChangesIn()).Key);
        var gitDir = Path.Combine(_modFolder, ".git");
        GitProbe.Run(gitDir, _modFolder, "add", "-A");
        GitProbe.Run(gitDir, _modFolder, "commit", "-q", "-m", "Edited");

        Assert.Empty(ChangesIn());
    }
}
