namespace MEditService.SourceAdapter;

/// <summary>A source mod's repository as a submodule of the instance repository (ADR-0022): git holds its remote, its pin
/// and the branch it follows, and git clones it. Modbench moves no commit and no existing branch.</summary>
internal static class Submodules
{
    private const string Origin = "origin";

    /// <summary>For a repository with a remote: whether its working tree holds changes no commit holds, and whether
    /// <c>origin</c>, else the first remote by name, as last fetched, lacks HEAD. None with no repository or no remote.</summary>
    internal static (bool Uncommitted, bool Unpushed)? RemoteOf(string sourceFolder)
    {
        var git = SourceRepositoryGit.Holding(sourceFolder);
        if (!git.Exists) return null;
        var remotes = git.Run("remote").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var remote = remotes.Contains(Origin) ? Origin : remotes.Order(StringComparer.Ordinal).FirstOrDefault();
        return remote is null ? null : (git.HoldsUncommittedChanges(), !git.RemoteHoldsHead(remote));
    }

    internal static SubmoduleHead CommitAtHead(Submodule submodule, CancellationToken cancel)
    {
        var cloned = HoldsNothing(submodule.Folder);
        if (cloned) Clone(submodule, cancel);
        var git = SourceRepositoryGit.Own(submodule.Folder);
        if (!git.Exists) throw SourceStopException.Unreadable($"'{submodule.Folder}' holds no repository.");
        var head = git.HeadCommit() ?? throw SourceStopException.Unreadable($"'{submodule.Folder}' holds no commit.");
        var detachedAtThePin = head == submodule.Pin && git.Run("branch", "--show-current").Length == 0;
        return new SubmoduleHead(head, detachedAtThePin ? Landed(git, submodule, cloned) : null);
    }

    private static string? Landed(SourceRepositoryGit git, Submodule submodule, bool cloned)
    {
        if (submodule.Branch is { } followed && BranchExists(git, followed)) return OnTheBranch(git, followed, submodule.Pin);
        if (!cloned) return null;
        if (RemoteDefaultBranch(git) is { } fallback) return OnTheBranch(git, fallback, submodule.Pin);
        var atThePin = RemoteBranchesAt(git, submodule.Pin);
        return atThePin.Count == 1
            ? OnTheBranch(git, atThePin[0], submodule.Pin)
            : "its remote names no default branch and not exactly one of its branches is at the pin, so it is left detached at the pin";
    }

    private static List<string> RemoteBranchesAt(SourceRepositoryGit git, string commit) =>
        [.. git.Run("for-each-ref", "--points-at", commit, "--format=%(refname:lstrip=3)", $"refs/remotes/{Origin}")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)];

    private static bool BranchExists(SourceRepositoryGit git, string branch) =>
        git.TryRun(out _, "rev-parse", "--verify", "-q", $"refs/heads/{branch}") || git.TryRun(out _, "rev-parse", "--verify", "-q", $"refs/remotes/{Origin}/{branch}");

    private static string? RemoteDefaultBranch(SourceRepositoryGit git) =>
        git.TryRun(out var head, "symbolic-ref", "--short", $"refs/remotes/{Origin}/HEAD") ? head.Trim()[(Origin.Length + 1)..] : null;

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
            var git = SourceRepositoryGit.Own(submodule.Folder);
            foreach (var (key, value) in GitInit.Settings) git.Run("config", key, value);
            GitInit.EnsureCommitIdentity(git);
            if (!SourceRepositoryGit.HoldsSourceMod(submodule.Folder) && !git.TryRun(out _, "branch", "--track", "main", $"{Origin}/main"))
                throw SourceStopException.Unreadable("its remote has no main, so it is not a source mod's repository");
        }
        catch (SourceStopException) when (Directory.Exists(submodule.Folder))
        {
            Empty(submodule.Folder);
            throw;
        }
    }

    private static bool LacksPin(Submodule submodule)
    {
        var git = SourceRepositoryGit.Own(submodule.Folder);
        return git.Exists && !git.TryRun(out _, "cat-file", "-e", $"{submodule.Pin}^{{commit}}");
    }

    // The git directory a deinit keeps holds its local branches, and one can hold commits no remote holds.
    private static string? OnTheBranch(SourceRepositoryGit git, string branch, string pin)
    {
        try
        {
            var local = BranchTip(git, $"refs/heads/{branch}");
            var tip = local ?? BranchTip(git, $"refs/remotes/{Origin}/{branch}");
            if (tip != pin) return $"its branch '{branch}' is at {tip}, not at the pin, so it is left detached at the pin";
            if (local is null) git.Run("checkout", "-q", "-b", branch, "--track", $"{Origin}/{branch}");
            else git.Run("checkout", "-q", branch);
            return null;
        }
        catch (SourceStopException stop)
        {
            return $"its branch '{branch}' could not be checked out ({stop.Message}), so it is left detached at the pin";
        }
    }

    private static string? BranchTip(SourceRepositoryGit git, string reference) =>
        git.TryRun(out var tip, "rev-parse", "--verify", "-q", reference) ? tip.Trim() : null;

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
