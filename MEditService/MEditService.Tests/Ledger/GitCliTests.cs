using MEditService.Core.Ledger;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #410: <see cref="GitCli"/> is on ADR-0041's keep-list, but every test that reached it did so
/// through the hidden-gitdir layer this ticket deletes. One direct test replaces that indirect
/// coverage at the same seam, so the keep-list item is not left unverified until Track (#413)
/// arrives to use it. Real git against a scratch directory — the only way this class is ever
/// exercised, by its own design note.
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
}
