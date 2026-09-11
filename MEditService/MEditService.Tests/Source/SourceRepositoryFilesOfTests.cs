using System.Text;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>A plugin's whole source as the carrier Track hands in — relative path and bytes — at the
/// working tree or at a named ref. What compile takes instead of a directory.</summary>
public sealed class SourceRepositoryFilesOfTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private SourceRepository Repository => SourceRepository.Open(_mod.ModFolder, GameRelease.Fallout4)!;

    private string SourceRoot =>
        Path.Combine(_mod.ModFolder, SourceRepository.RootFor(CompileFixture.PluginName));

    private List<string> PathsOnDisk() =>
        [.. Directory.EnumerateFiles(SourceRoot, "*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(_mod.ModFolder, file))
            .Order(StringComparer.Ordinal)];

    [Fact]
    public void FilesOf_AtTheWorkingTree_AnswersEveryFileUnderThePluginsSourceRoot_WithItsOwnBytes()
    {
        var files = Repository.FilesOf(_mod.Plugin, gitRef: null);

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

        var atRef = Repository.FilesOf(_mod.Plugin, "HEAD");
        var workingTree = Repository.FilesOf(_mod.Plugin, gitRef: null);

        Assert.Equal(committed, atRef.Single(f => f.RelativePath == npcRelativePath).Content);
        Assert.Equal(
            Encoding.UTF8.GetBytes("{ not valid json"),
            workingTree.Single(f => f.RelativePath == npcRelativePath).Content);
        Assert.Equal(
            [.. workingTree.Select(f => f.RelativePath).Order(StringComparer.Ordinal)],
            [.. atRef.Select(f => f.RelativePath).Order(StringComparer.Ordinal)]);
    }

    [Fact]
    public void FilesOf_ForAPluginTheTreeHoldsNoSourceFor_IsEmpty_AtEitherSource()
    {
        var stranger = new PluginKey("Stranger.esp", CompileFixture.Origin);

        Assert.Empty(Repository.FilesOf(stranger, gitRef: null));
        Assert.Empty(Repository.FilesOf(stranger, "HEAD"));
    }
}
