using MEditService.LoadOrder;
using MEditService.SourceRepo;

namespace MEditService.Tests.Source;

/// <summary>The encoding only needs to be stable and injective, not reversible: nothing enumerates
/// these refs.</summary>
public sealed class SourceRepositoryLastCompileRefTests
{
    [Fact]
    public void LastCompileRef_IsIdentity_ForAnAlreadyRefSafeName()
    {
        Assert.Equal("refs/medit/last-compile/Test.esp", SourceRepository.LastCompileRef("Test.esp"));
    }

    [Fact]
    public void LastCompileRef_ProducesAGitCheckRefFormatValidRef_ForASpaceAndBracketName() =>
        AssertRefIsCheckRefFormatValid("[ARRETH] FGEP-DE.esp");

    [Fact]
    public void LastCompileRef_IsInjective_ForNamesDifferingOnlyInAForbiddenCharacter()
    {
        // The rival this pins against: a naive scheme that replaces every forbidden character with
        // "_" would map "A B.esp" and "A_B.esp" to the identical ref — silently merging two distinct
        // plugins' parked baselines.
        Assert.NotEqual(SourceRepository.LastCompileRef("A B.esp"), SourceRepository.LastCompileRef("A_B.esp"));
    }

    [Fact]
    public void LastCompileRef_ProducesAGitCheckRefFormatValidRef_ForANameEndingInDotLock() =>
        AssertRefIsCheckRefFormatValid("SomePlugin.lock");

    [Fact]
    public void LastCompileRef_Throws_ForAnEmptyPluginName() =>
        Assert.Throws<ArgumentException>(() => SourceRepository.LastCompileRef(""));

    private static void AssertRefIsCheckRefFormatValid(string plugin)
    {
        var gitDir = Path.Combine(Directory.CreateTempSubdirectory("medit-checkrefformat-").FullName, ".git");
        var workTree = PathShape.DirectoryOf(gitDir);
        try
        {
            GitCli.Run(gitDir, workTree, "init", "-q", "-b", "main");

            var refName = SourceRepository.LastCompileRef(plugin);

            Assert.True(GitCli.TryRun(gitDir, workTree, out _, "check-ref-format", "--normalize", refName));
        }
        finally
        {
            Directory.Delete(workTree, recursive: true);
        }
    }
}
