using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Uncommitted state through the tracked-files-outside-source query (ADR-0003).</summary>
public sealed class SourceRepositoryUncommittedStateTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-uncommitted-").FullName;

    // ---- what git last saw is the index (ADR-0003 invariant 3) ----

    // Keep's answer is the staged index, so a change staged and untouched since is nothing to ask
    // about again; the rival is a query answering from HEAD, which asks after every restart.
    [Fact]
    public void ChangedTrackedFilesOutsideSource_LeavesOutAChangeStagedAndUntouchedSince()
    {
        var modFolder = TrackedEverythingWithAsset();
        try
        {
            File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "changed-by-the-release");
            GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "add", "--", "texture.dds");

            Assert.Empty(SourceRepository.ChangedTrackedFilesOutsideSource(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // A file staged by Keep and then edited again differs from the index once more, and the
    // staged half is what Keep refuses to overwrite.
    [Fact]
    public void ChangedTrackedFilesOutsideSource_NamesAFileEditedAgainAfterStaging_AsStagedAlready()
    {
        var modFolder = TrackedEverythingWithAsset();
        try
        {
            File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "changed-by-the-release");
            GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "add", "--", "texture.dds");
            File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "changed-again-by-hand");

            var change = Assert.Single(SourceRepository.ChangedTrackedFilesOutsideSource(modFolder));

            Assert.Equal("texture.dds", change.RelativePath);
            Assert.Equal(TrackedFileChangeKind.Modified, change.Kind);
            Assert.True(change.StagedAlready);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // A file another tool added is untracked on both halves, and git's view has never held it.
    [Fact]
    public void ChangedTrackedFilesOutsideSource_NamesAFileAnotherToolAdded()
    {
        var modFolder = TrackedEverythingWithAsset();
        try
        {
            File.WriteAllText(Path.Combine(modFolder, "added.dds"), "dropped-by-the-release");

            var change = Assert.Single(SourceRepository.ChangedTrackedFilesOutsideSource(modFolder));

            Assert.Equal("added.dds", change.RelativePath);
            Assert.Equal(TrackedFileChangeKind.Modified, change.Kind);
            Assert.False(change.StagedAlready);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    private static string TrackedEverythingWithAsset()
    {
        var modFolder = NewModFolder();
        File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "original");
        var files = new[] { new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
        PluginBaselines.Track(modFolder, SourcePreset.Everything, files);
        return modFolder;
    }

    // Never-assume-exclusive-ownership: a mod folder can be asked about before it is ever tracked,
    // and that must read as "nothing changed", not a throw.
    [Fact]
    public void ChangedTrackedFilesOutsideSource_ForAnUntrackedFolder_IsEmpty_NotAThrow()
    {
        var modFolder = NewModFolder();
        try
        {
            Assert.Empty(SourceRepository.ChangedTrackedFilesOutsideSource(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
