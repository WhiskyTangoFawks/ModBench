using System.Collections.Concurrent;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>What git said a file held at the last commit, kept per source folder until the last commit moves. Git is
/// asked which commit that is only when the files a commit moves HEAD through have changed.</summary>
internal sealed class CommittedTexts(TimeProvider time)
{
    private sealed class Kept(string commit)
    {
        internal string Commit { get; } = commit;

        internal FilesStamp? HeadFiles { get; set; }

        internal ConcurrentDictionary<string, string?> Texts { get; } = new(StringComparer.Ordinal);
    }

    private readonly ConcurrentDictionary<string, Kept> _kept = new(StringComparer.Ordinal);

    /// <summary>The text of <paramref name="relativePath"/> at the last commit, or null when it holds none.</summary>
    internal string? Of(string sourceFolder, SourceRepositoryGit git, string relativePath)
    {
        if (!SourceRepositoryGit.HoldsSourceMod(sourceFolder)) return null;

        var headFiles = FilesStamp.Of(git.HeadFiles(), time);
        var kept = _kept.GetValueOrDefault(sourceFolder);
        if (kept is null || !headFiles.Vouches || !headFiles.Equals(kept.HeadFiles))
        {
            if (git.HeadCommit() is not { } commit) return null;

            kept = kept?.Commit == commit ? kept : new Kept(commit);
            kept.HeadFiles = headFiles;
            _kept[sourceFolder] = kept;
        }
        return kept.Texts.GetOrAdd(relativePath, path => git.ReadCommittedSourceText(path));
    }
}
