using System.Text;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>A plugin's whole source as the carrier Track hands in — relative path and bytes — at the
/// working tree or at a named ref. What compile takes instead of a directory.</summary>
public sealed class SourceRepositoryFilesOfTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private SourceRepository Repository => SourceRepository.Open(_mod.ModFolder, GameRelease.Fallout4)
        ?? throw new InvalidOperationException("Expected a tracked mod folder to open a source repository.");

    private string SourceRoot =>
        Path.Combine(_mod.ModFolder, SourceRepository.RootFor(CompileFixture.PluginName));

    private List<string> PathsOnDisk() =>
        [.. Directory.EnumerateFiles(SourceRoot, "*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(_mod.ModFolder, file))
            .Order(StringComparer.Ordinal)];

    [Fact]
    public void FilesOf_AtTheWorkingTree_AnswersEveryFileUnderThePluginsSourceRoot_WithItsOwnBytes()
    {
        var files = Repository.FilesOf(_mod.Plugin, gitRef: null).Files;

        Assert.Equal(PathsOnDisk(), [.. files.Select(f => f.RelativePath).Order(StringComparer.Ordinal)]);
        var npc = files.Single(f => f.RelativePath == Path.GetRelativePath(_mod.ModFolder, _mod.NpcSourceFile));
        Assert.Equal(File.ReadAllBytes(_mod.NpcSourceFile), npc.Content);
    }

    [Fact]
    public void FilesOf_AtARef_AnswersWhatThatRefCommitted_NotWhatTheWorkingTreeHolds()
    {
        var committed = File.ReadAllBytes(_mod.NpcSourceFile);
        var npcRelativePath = Path.GetRelativePath(_mod.ModFolder, _mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, "{ not valid json");

        var atRef = Repository.FilesOf(_mod.Plugin, "HEAD").Files;
        var workingTree = Repository.FilesOf(_mod.Plugin, gitRef: null).Files;

        Assert.Equal(committed, atRef.Single(f => f.RelativePath == npcRelativePath).Content);
        Assert.Equal(
            Encoding.UTF8.GetBytes("{ not valid json"),
            workingTree.Single(f => f.RelativePath == npcRelativePath).Content);
        Assert.Equal(
            [.. workingTree.Select(f => f.RelativePath).Order(StringComparer.Ordinal)],
            [.. atRef.Select(f => f.RelativePath).Order(StringComparer.Ordinal)]);
    }

    // One repository spans a write and the reads around it, so the file memo a write leaves behind
    // would answer about the tree as it stood.
    [Fact]
    public void FilesOf_AfterAPutThroughTheSameRepository_AnswersTheTreeAsItNowStands()
    {
        var repository = Repository;
        var before = repository.FilesOf(_mod.Plugin, gitRef: null).Files.Count;

        SourceEdits.Write(
            repository,
            _mod.Plugin,
            new Npc(FormKey.Factory($"000950:{CompileFixture.PluginName}"), Fallout4Release.Fallout4)
            {
                EditorID = "MemoNpc",
            },
            CompileFixture.NpcRecordType,
            GameRelease.Fallout4);

        Assert.Equal(before + 1, repository.FilesOf(_mod.Plugin, gitRef: null).Files.Count);
    }

    // Half a tree is the one answer that must not escape: a caller cannot tell it from a smaller tree,
    // and compiling it writes a binary missing records.
    [Fact]
    public void FilesOf_WhenAFileCannotBeRead_NamesThatFile_AndAnswersNoFiles()
    {
        using var held = new FileStream(_mod.NpcSourceFile, FileMode.Open, FileAccess.Read, FileShare.None);

        var files = Repository.FilesOf(_mod.Plugin, gitRef: null);

        Assert.Equal(Path.GetRelativePath(_mod.ModFolder, _mod.NpcSourceFile), files.Unreadable);
        Assert.Empty(files.Files);
    }

    [Fact]
    public void FilesOf_ForAPluginTheTreeHoldsNoSourceFor_IsEmpty_AtEitherSource()
    {
        var stranger = new PluginCopyKey("Stranger.esp", CompileFixture.Origin);

        Assert.Empty(Repository.FilesOf(stranger, gitRef: null).Files);
        Assert.Empty(Repository.FilesOf(stranger, "HEAD").Files);
    }
}
