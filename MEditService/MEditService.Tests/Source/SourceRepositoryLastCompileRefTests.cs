using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// #433: <see cref="SourceRepository.LastCompileRef"/> — the single source of truth for encoding a
/// plugin filename into <c>refs/medit/last-compile/&lt;plugin&gt;</c>. The encoding only needs to be
/// stable and injective (two distinct plugin filenames must never produce the same ref) — it does
/// not need to be reversible, since nothing enumerates these refs (triage decision on #433).
/// </summary>
public sealed class SourceRepositoryLastCompileRefTests
{
    [Fact]
    public void LastCompileRef_IsIdentity_ForAnAlreadyRefSafeName()
    {
        Assert.Equal("refs/medit/last-compile/Test.esp", SourceRepository.LastCompileRef("Test.esp"));
    }

    [Fact]
    public void LastCompileRef_ProducesAGitCheckRefFormatValidRef_ForASpaceAndBracketName()
    {
        var gitDir = Path.Combine(Directory.CreateTempSubdirectory("medit-checkrefformat-").FullName, ".git");
        var workTree = Path.GetDirectoryName(gitDir)!;
        try
        {
            GitCli.Run(gitDir, workTree, "init", "-q", "-b", "main");

            var refName = SourceRepository.LastCompileRef("[ARRETH] FGEP-DE.esp");

            Assert.True(GitCli.TryRun(gitDir, workTree, out _, "check-ref-format", "--normalize", refName));
        }
        finally
        {
            Directory.Delete(workTree, recursive: true);
        }
    }

    [Fact]
    public void LastCompileRef_IsInjective_ForNamesDifferingOnlyInAForbiddenCharacter()
    {
        // The rival this pins against: a naive scheme that replaces every forbidden character with
        // "_" would map "A B.esp" and "A_B.esp" to the identical ref — silently merging two distinct
        // plugins' parked baselines. Confirmed failing against exactly that naive scheme before this
        // (real) implementation landed.
        Assert.NotEqual(SourceRepository.LastCompileRef("A B.esp"), SourceRepository.LastCompileRef("A_B.esp"));
    }
}
