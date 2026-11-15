using System.Collections.Concurrent;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>What git said a file held at the last commit, kept per source folder until the last commit moves. Git is
/// asked for the commit when the files HEAD moves through changed or have not settled.</summary>
internal sealed class CommittedTexts(TimeProvider time)
{
    private sealed class Kept(string? commit)
    {
        internal string? Commit { get; } = commit;

        internal FilesStamp? SettledHeadFiles { get; set; }

        internal ConcurrentDictionary<string, string?> Texts { get; } = new(StringComparer.Ordinal);
    }

    private readonly ConcurrentDictionary<string, Kept> _kept = new(StringComparer.Ordinal);

    /// <summary>The text of <paramref name="relativePath"/> at the last commit, or null when it holds none.</summary>
    internal string? Of(SourceRepositoryGit git, string relativePath)
    {
        if (!SourceRepositoryGit.HoldsSourceMod(git.SourceFolder)) return null;

        var headFiles = FilesStamp.Of(git.HeadFiles(), time);
        var kept = _kept.GetValueOrDefault(git.SourceFolder);
        if (kept?.SettledHeadFiles is null || !headFiles.Equals(kept.SettledHeadFiles))
        {
            var commit = git.HeadCommit();
            kept = kept is not null && kept.Commit == commit ? kept : new Kept(commit);
            kept.SettledHeadFiles = headFiles.Vouches ? headFiles : null;
            _kept[git.SourceFolder] = kept;
        }
        var committed = kept.Commit;
        return committed is null ? null : kept.Texts.GetOrAdd(relativePath, path => git.ReadCommittedSourceText(committed, path));
    }
}
