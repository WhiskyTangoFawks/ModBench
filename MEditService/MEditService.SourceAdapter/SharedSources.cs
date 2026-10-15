using System.Text.RegularExpressions;

namespace MEditService.SourceAdapter;

/// <summary>A source as a clone on another machine gets it (ADR-0022): its remote and a commit. Modbench never moves a
/// repository it did not clone.</summary>
internal static partial class SharedSources
{
    private const string Origin = "origin";

    /// <summary>The remote <c>origin</c>, else the first by name, at the commit at HEAD; none for a folder with no
    /// repository, or a remote only this machine reaches.</summary>
    internal static SharedSource? SharedOf(string sourceFolder)
    {
        var git = new SourceRepositoryGit(sourceFolder);
        if (!git.Exists) return null;
        var remotes = git.Run("remote").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var remote = remotes.Contains(Origin) ? Origin : remotes.Order(StringComparer.Ordinal).FirstOrDefault();
        return remote is not null && Shareable(git.Run("remote", "get-url", remote).Trim()) is { } url ? new SharedSource(url, git.HeadCommit()) : null;
    }

    // modlist-source.md, The manifest, story 8: no path from this machine, and so no credential, is committed.
    private static string? Shareable(string url)
    {
        if (url.Contains("://", StringComparison.Ordinal) && Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return uri.IsFile ? null : WithoutCredential(url, uri);
        return ScpLike().IsMatch(url) ? url : null;
    }

    // An HTTP user is a credential; another scheme's user names the account, so only its password goes.
    private static string WithoutCredential(string url, Uri uri)
    {
        if (uri.UserInfo.Length == 0) return url;
        var at = url.IndexOf("://", StringComparison.Ordinal) + 3;
        var end = url.IndexOf('@', at);
        var user = uri.Scheme is "http" or "https" ? "" : url[at..end].Split(':')[0] + "@";
        return url[..at] + user + url[(end + 1)..];
    }

    // git's scp-like form, [user@]host:path, whose host is longer than a Windows drive letter.
    [GeneratedRegex(@"^([^@/\\:]+@)?[^@/\\:]{2,}:")]
    private static partial Regex ScpLike();

    internal static bool HoldsUncommittedChanges(string sourceFolder) =>
        new SourceRepositoryGit(sourceFolder).Run("status", "--porcelain", "--untracked-files=all").Length > 0;

    internal static string CommitAtHead(string sourceFolder, SharedSource cloneFrom)
    {
        if (!Directory.Exists(sourceFolder)) Clone(sourceFolder, cloneFrom);
        var git = new SourceRepositoryGit(sourceFolder);
        return git.Exists ? git.HeadCommit() : throw SourceStopException.Unreadable($"'{sourceFolder}' holds no repository.");
    }

    private static void Clone(string sourceFolder, SharedSource source)
    {
        GitCli.Clone(source.Remote, sourceFolder);
        try
        {
            var git = new SourceRepositoryGit(sourceFolder);
            if (git.HeadCommit() != source.Commit) git.Run("checkout", "-q", "--detach", source.Commit);
        }
        catch (SourceStopException)
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
