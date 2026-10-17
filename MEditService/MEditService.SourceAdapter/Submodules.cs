namespace MEditService.SourceAdapter;

/// <summary>A source mod's repository as a submodule of the instance repository (ADR-0023): git holds its remote, its pin
/// and the branch it follows, and git clones it. Modbench never moves a repository it did not clone.</summary>
internal static class Submodules
{
    private const string Origin = "origin";

    /// <summary>For a repository with a remote: whether its working tree holds changes no commit holds, and whether
    /// <c>origin</c>, else the first remote by name, as last fetched, lacks HEAD. None with no repository or no remote.</summary>
    internal static (bool Uncommitted, bool Unpushed)? RemoteOf(string sourceFolder)
    {
        var git = new SourceRepositoryGit(sourceFolder);
        if (!git.Exists) return null;
        var remotes = git.Run("remote").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var remote = remotes.Contains(Origin) ? Origin : remotes.Order(StringComparer.Ordinal).FirstOrDefault();
        return remote is null ? null : (git.HoldsUncommittedChanges(), !git.RemoteHoldsHead(remote));
    }

    internal static string CommitAtHead(Submodule submodule, CancellationToken cancel)
    {
        if (HoldsNothing(submodule.Folder)) Clone(submodule, cancel);
        var git = new SourceRepositoryGit(submodule.Folder);
        return git.Exists ? git.HeadCommit() : throw SourceStopException.Unreadable($"'{submodule.Folder}' holds no repository.");
    }

    // A clone of the instance repository leaves an empty folder where each submodule goes.
    private static bool HoldsNothing(string folder) => !Directory.Exists(folder) || !Directory.EnumerateFileSystemEntries(folder).Any();

    // git checks the submodule out at its pin with HEAD detached, and a source mod's repository has a main (ADR-0007).
    private static void Clone(Submodule submodule, CancellationToken cancel)
    {
        try
        {
            try
            {
                GitCli.UpdateSubmodule(submodule.Folder, [.. GitInit.Settings, ("clone.defaultRemoteName", Origin)], cancel);
            }
            catch (SourceStopException) when (!cancel.IsCancellationRequested && LacksPin(submodule))
            {
                throw SourceStopException.GitFailed($"its remote holds no commit {submodule.Pin}");
            }
            var git = new SourceRepositoryGit(submodule.Folder);
            foreach (var (key, value) in GitInit.Settings) git.Run("config", key, value);
            GitInit.EnsureCommitIdentity(git);
            if (!SourceRepositoryGit.HoldsRepository(submodule.Folder) && !git.TryRun(out _, "branch", "--track", "main", $"{Origin}/main"))
                throw SourceStopException.Unreadable("its remote has no main, so it is not a source mod's repository");
            if (submodule.Branch is { } branch && FollowedBranchIsAtThePin(git, branch, submodule.Pin))
                git.Run("checkout", "-q", "-B", branch, "--track", $"{Origin}/{branch}");
        }
        catch (SourceStopException) when (Directory.Exists(submodule.Folder))
        {
            Empty(submodule.Folder);
            throw;
        }
    }

    private static bool LacksPin(Submodule submodule)
    {
        var git = new SourceRepositoryGit(submodule.Folder);
        return git.Exists && !git.TryRun(out _, "cat-file", "-e", $"{submodule.Pin}^{{commit}}");
    }

    private static bool FollowedBranchIsAtThePin(SourceRepositoryGit git, string branch, string pin) =>
        git.TryRun(out var followed, "rev-parse", "--verify", "-q", $"refs/remotes/{Origin}/{branch}") && followed.Trim() == pin;

    // Windows refuses to delete the read-only files git writes.
    private static void Empty(string folder)
    {
        foreach (var file in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        foreach (var entry in new DirectoryInfo(folder).EnumerateFileSystemInfos())
        {
            if (entry is DirectoryInfo directory) directory.Delete(recursive: true);
            else entry.Delete();
        }
    }
}
