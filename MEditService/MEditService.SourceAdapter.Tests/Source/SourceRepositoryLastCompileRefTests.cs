using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

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
    public void LastCompileRef_IsInjective_ForASpaceNameAndTheUnderscoreNameAnUnderscoreReplacementWouldMergeItWith()
    {
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
        using var workTree = new ScratchDirectory("medit-checkrefformat-");
        var gitDir = Path.Combine(workTree, ".git");
        GitProbe.Run(gitDir, workTree, "init", "-q", "-b", "main");

        var refName = SourceRepository.LastCompileRef(plugin);

        Assert.True(GitProbe.TryRun(gitDir, workTree, out _, "check-ref-format", "--normalize", refName));
    }
}
