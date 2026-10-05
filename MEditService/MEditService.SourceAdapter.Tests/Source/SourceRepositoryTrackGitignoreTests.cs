using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryTrackGitignoreTests
{
    private static TreeFile SourceFile() =>
        new(Path.Combine("plugin-source", "Test.esp", "npc_", "Test.esp", "000001.json"), "{}"u8.ToArray());

    private static void WriteMetaIniWhichChangesForNonContentReasonsBesideTheSource(string modFolder) =>
        File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "[General]\nversion=1.0\n");

    private static void WritePluginBinaryBesideTheSource(string modFolder) =>
        File.WriteAllBytes(Path.Combine(modFolder, "Test.esp"), [0x01, 0x02]);

    private static string CommittedPaths(string modFolder) =>
        GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "ls-tree", "-r", "--name-only", "main");

    [Fact]
    public void Track_ExcludesMetaIniAndTheCompiledPluginBinaryFromTheCommit()
    {
        using var modFolder = new ScratchDirectory("medit-track-gitignore-");
        WriteMetaIniWhichChangesForNonContentReasonsBesideTheSource(modFolder);
        WritePluginBinaryBesideTheSource(modFolder);

        PluginBaselines.Track(modFolder, [SourceFile()]);

        var gitDir = Path.Combine(modFolder, ".git");
        var committedPaths = CommittedPaths(modFolder);
        Assert.Contains("plugin-source/Test.esp/npc_/Test.esp/000001.json", committedPaths);
        Assert.DoesNotContain("meta.ini", committedPaths);
        Assert.DoesNotContain("Test.esp\n", committedPaths + "\n");
        Assert.True(GitProbe.TryRun(gitDir, modFolder, out _, "check-ignore", "meta.ini"));
        Assert.True(GitProbe.TryRun(gitDir, modFolder, out _, "check-ignore", "Test.esp"));
    }

    [Fact]
    public void Track_IgnoresEverythingExceptTheSource()
    {
        using var modFolder = new ScratchDirectory("medit-track-gitignore-");
        File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "not really a texture");

        PluginBaselines.Track(modFolder, [SourceFile()]);

        var committedPaths = CommittedPaths(modFolder);
        Assert.Contains("plugin-source/Test.esp/npc_/Test.esp/000001.json", committedPaths);
        Assert.DoesNotContain("texture.dds", committedPaths);
    }

    [Fact]
    public void Track_DoesNotUnignoreATopLevelFolderThatMerelyEndsWithPluginSource_ForThePatternIsNotASuffixMatch()
    {
        using var modFolder = new ScratchDirectory("medit-track-gitignore-");
        Directory.CreateDirectory(Path.Combine(modFolder, "My-plugin-source"));
        File.WriteAllText(Path.Combine(modFolder, "My-plugin-source", "notes.txt"), "Notes");

        PluginBaselines.Track(modFolder, [SourceFile()]);

        Assert.DoesNotContain("My-plugin-source", CommittedPaths(modFolder));
    }

    [Fact]
    public void Track_TracksExactlyGitignorePlusTheWholeSourceTree_NothingElse()
    {
        using var modFolder = new ScratchDirectory("medit-track-gitignore-");
        WriteMetaIniWhichChangesForNonContentReasonsBesideTheSource(modFolder);
        WritePluginBinaryBesideTheSource(modFolder);
        File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "not really a texture");
        Directory.CreateDirectory(Path.Combine(modFolder, "My-plugin-source"));
        File.WriteAllText(Path.Combine(modFolder, "My-plugin-source", "notes.txt"), "Notes");

        var otherPluginFile = new TreeFile(
            Path.Combine("plugin-source", "Other.esp", "npc_", "Other.esp", "000002.json"), "{}"u8.ToArray());

        PluginBaselines.Track(modFolder, [SourceFile(), otherPluginFile]);

        var committedPaths = CommittedPaths(modFolder)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .OrderBy(p => p, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(
            new[]
            {
                ".gitignore",
                "plugin-source/Other.esp/npc_/Other.esp/000002.json",
                "plugin-source/Test.esp/npc_/Test.esp/000001.json",
            }.OrderBy(p => p, StringComparer.Ordinal),
            committedPaths);
    }
}
