namespace MEditService.SourceAdapter;

/// <summary>A source as a clone on another machine gets it (ADR-0022): its remote and a commit. Modbench never moves a
/// repository it did not clone.</summary>
internal static class SharedSources
{
    private const string Origin = "origin";

    /// <summary>The remote <c>origin</c>, else the first by name, at the commit at HEAD; none for a folder with no
    /// repository or a repository with no remote.</summary>
    internal static SharedSource? SharedOf(string sourceFolder)
    {
        var git = new SourceRepositoryGit(sourceFolder);
        if (!git.Exists) return null;
        var remotes = git.Run("remote").Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var remote = remotes.Contains(Origin) ? Origin : remotes.Order(StringComparer.Ordinal).FirstOrDefault();
        return remote is null ? null : new SharedSource(git.Run("remote", "get-url", remote).Trim(), git.HeadCommit());
    }

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
