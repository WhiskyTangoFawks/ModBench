using System.Text.RegularExpressions;

namespace MEditService.SourceAdapter;

/// <summary>A source as a clone on another machine gets it (ADR-0022): its remote and a commit. Modbench never moves a
/// repository it did not clone.</summary>
internal static partial class SharedSources
{
    private const string Origin = "origin";

    /// <summary>The remote <c>origin</c>, else the first by name, at HEAD, as <see cref="SourceToBuild"/> reads it. None
    /// for a folder with no repository, or a remote that cannot be written safely.</summary>
    internal static (SharedSource Shared, bool Uncommitted, bool Unpushed)? SharingOf(string sourceFolder)
    {
        var git = new SourceRepositoryGit(sourceFolder);
        if (!git.Exists) return null;
        var remotes = git.Run("remote").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var remote = remotes.Contains(Origin) ? Origin : remotes.Order(StringComparer.Ordinal).FirstOrDefault();
        if (remote is null || Shareable(git.Run("remote", "get-url", remote).Trim()) is not { } url) return null;
        return (new SharedSource(url, git.HeadCommit()), git.HoldsUncommittedChanges(), !git.RemoteHoldsHead(remote));
    }

    // modlist-repository.md, The manifest, story 8: no path from this machine, and so no credential, is committed. A URL
    // that cannot be read safely is not written at all.
    private static string? Shareable(string url)
    {
        if (url.Contains("://", StringComparison.Ordinal))
            return Uri.TryCreate(url, UriKind.Absolute, out var uri) && !uri.IsFile ? WithoutCredential(uri) : null;
        return ScpLike().IsMatch(url) ? url : null;
    }

    // An HTTP user is a credential; another scheme's user names the account, so only its password goes.
    private static string WithoutCredential(Uri uri)
    {
        var user = uri.UserInfo.Split(':')[0];
        var account = user.Length == 0 || uri.Scheme is "http" or "https" ? "" : user + "@";
        return $"{uri.Scheme}://{account}{uri.Authority}{uri.PathAndQuery}{uri.Fragment}";
    }

    // git's scp-like form, [user@]host:path, whose host is longer than a Windows drive letter, and no password before an @.
    [GeneratedRegex(@"^(?![^/@]*:[^/]*@)([^@/\\:]+@)?[^@/\\:]{2,}:")]
    private static partial Regex ScpLike();

    internal static string CommitAtHead(string sourceFolder, SharedSource cloneFrom, CancellationToken cancel)
    {
        if (!Directory.Exists(sourceFolder)) Clone(sourceFolder, cloneFrom, cancel);
        var git = new SourceRepositoryGit(sourceFolder);
        return git.Exists ? git.HeadCommit() : throw SourceStopException.Unreadable($"'{sourceFolder}' holds no repository.");
    }

    // A source mod's repository has a main (ADR-0007): a clone whose default branch is another takes the remote's, and
    // Modbench never invents one.
    private static void Clone(string sourceFolder, SharedSource source, CancellationToken cancel)
    {
        if (source.Remote.StartsWith('-'))
            throw SourceStopException.GitFailed($"its remote '{source.Remote}' is not a remote git can clone");
        try
        {
            GitCli.Clone(source.Remote, sourceFolder, GitInit.Settings, cancel);
            var git = new SourceRepositoryGit(sourceFolder);
            GitInit.EnsureCommitIdentity(git);
            if (!SourceRepositoryGit.HoldsRepository(sourceFolder) && !git.TryRun(out _, "branch", "--track", "main", "origin/main"))
                throw SourceStopException.Unreadable("its remote has no main, so it is not a source mod's repository");
            if (git.HeadCommit() != source.Commit) git.Run("checkout", "-q", "--detach", source.Commit);
        }
        catch (SourceStopException) when (Directory.Exists(sourceFolder))
        {
            Delete(sourceFolder);
            throw;
        }
    }

    // Windows refuses to delete the read-only files git writes.
    private static void Delete(string folder)
    {
        foreach (var file in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
            File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(folder, recursive: true);
    }
}
