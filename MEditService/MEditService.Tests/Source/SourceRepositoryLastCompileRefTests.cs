using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// <see cref="SourceRepository.LastCompileRef"/> — the single source of truth for encoding a
/// plugin filename into <c>refs/medit/last-compile/&lt;plugin&gt;</c>. The encoding only needs to be
/// stable and injective (two distinct plugin filenames must never produce the same ref) — it does
/// not need to be reversible, since nothing enumerates these refs.
/// </summary>
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

    /// <summary>Git forbids a ref component ending in the literal sequence
    /// <c>.lock</c> (its own lock-file convention) — a structural rule beyond any forbidden-character
    /// list, same family as the leading-dot/trailing-dot/".." rules the encoder already
    /// handles. Unreachable via a real <c>.esp</c>/<c>.esm</c>/<c>.esl</c> extension, but the encoder
    /// has no way to know that, so it must not pass a <c>.lock</c>-suffixed name through unescaped.
    /// </summary>
    [Fact]
    public void LastCompileRef_ProducesAGitCheckRefFormatValidRef_ForANameEndingInDotLock() =>
        AssertRefIsCheckRefFormatValid("SomePlugin.lock");

    /// <summary>An empty plugin name would otherwise produce
    /// <c>refs/medit/last-compile/</c> — a ref ending in <c>/</c>, which git also rejects. Refused
    /// loudly (a caller passing an empty plugin name is a bug upstream) rather than silently encoded
    /// into some placeholder that could collide with a real plugin name.</summary>
    [Fact]
    public void LastCompileRef_Throws_ForAnEmptyPluginName() =>
        Assert.Throws<ArgumentException>(() => SourceRepository.LastCompileRef(""));

    private static void AssertRefIsCheckRefFormatValid(string plugin)
    {
        var gitDir = Path.Combine(Directory.CreateTempSubdirectory("medit-checkrefformat-").FullName, ".git");
        var workTree = Path.GetDirectoryName(gitDir)!;
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
