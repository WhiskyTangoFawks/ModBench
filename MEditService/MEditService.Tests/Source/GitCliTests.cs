using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// Direct coverage of <see cref="GitCli"/> (ADR-0041's keep-list) at its own seam. Real git against
/// a scratch directory — the only way this class is ever exercised, by its own design note.
/// </summary>
public sealed class GitCliTests
{
    [Fact]
    public void Run_InitCommitShow_RoundTripsFileContentThroughARealRepo()
    {
        var workTree = Directory.CreateTempSubdirectory("medit-gitcli-worktree-").FullName;
        var gitDir = Path.Combine(Directory.CreateTempSubdirectory("medit-gitcli-gitdir-").FullName, "gitdir");
        try
        {
            Directory.CreateDirectory(gitDir);
            GitCli.Run(gitDir, workTree, "init", "-q", "-b", "main");
            GitCli.Run(gitDir, workTree, "config", "user.email", "test@example.com");
            GitCli.Run(gitDir, workTree, "config", "user.name", "Test");

            File.WriteAllText(Path.Combine(workTree, "record.json"), "{\"editorId\":\"Committed\"}");
            GitCli.Run(gitDir, workTree, "add", "record.json");
            GitCli.Run(gitDir, workTree, "commit", "-q", "-m", "baseline");

            // The committed blob comes back through git, not off disk: overwrite the working-tree
            // file first, so a `show` that secretly read the file would return the new bytes.
            File.WriteAllText(Path.Combine(workTree, "record.json"), "{\"editorId\":\"Dirty\"}");

            Assert.Equal("{\"editorId\":\"Committed\"}", GitCli.Run(gitDir, workTree, "show", "main:record.json"));

            // TryRun's non-throwing path: a missing object is an expected answer, not an exception.
            Assert.False(GitCli.TryRun(gitDir, workTree, out _, "cat-file", "-e", "main:absent.json"));

            // Run's opposite contract: a failing git command must surface, never return empty
            // output that a caller would mistake for a real answer.
            var ex = Assert.Throws<InvalidOperationException>(
                () => GitCli.Run(gitDir, workTree, "show", "main:absent.json"));
            Assert.Contains("failed", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            Directory.Delete(workTree, recursive: true);
            Directory.Delete(Path.GetDirectoryName(gitDir)!, recursive: true);
        }
    }

    /// <summary>
    /// A failing git invocation must not put the absolute paths its own <c>args</c> carried
    /// (e.g. a scratch-spill path passed via <c>-m</c>) onto the exception message, since that
    /// message reaches the wire verbatim via the endpoint convention's <c>Results.Problem(ex.Message)</c>.
    /// <c>commit-tree</c> against a made-up tree-ish isolates this from the separate, out-of-scope
    /// question of what git's own stderr says: the failure here is "not a valid object name
    /// &lt;bogus-sha&gt;" — a reason wholly independent of the <c>-m</c> value — so stderr never
    /// echoes the path back; only the interpolated args vector could leak it.
    /// </summary>
    [Fact]
    public void Run_FailureWhoseArgsCarryAnAbsolutePath_OmitsThatPathButKeepsSubcommandAndStderr()
    {
        var workTree = Directory.CreateTempSubdirectory("medit-gitcli-worktree-").FullName;
        var gitDir = Path.Combine(Directory.CreateTempSubdirectory("medit-gitcli-gitdir-").FullName, "gitdir");
        try
        {
            Directory.CreateDirectory(gitDir);
            GitCli.Run(gitDir, workTree, "init", "-q", "-b", "main");
            GitCli.Run(gitDir, workTree, "config", "user.email", "test@example.com");
            GitCli.Run(gitDir, workTree, "config", "user.name", "Test");

            var absolutePath = Path.Combine(workTree, "medit-run-proposal-scratch", "spill.json");

            var ex = Assert.Throws<InvalidOperationException>(
                () => GitCli.Run(gitDir, workTree, "commit-tree", "not-a-real-tree-sha", "-m", absolutePath));

            Assert.DoesNotContain(absolutePath, ex.Message);
            Assert.Contains("commit-tree", ex.Message);
            Assert.Contains("not a valid object name", ex.Message);
        }
        finally
        {
            Directory.Delete(workTree, recursive: true);
            Directory.Delete(Path.GetDirectoryName(gitDir)!, recursive: true);
        }
    }
}
