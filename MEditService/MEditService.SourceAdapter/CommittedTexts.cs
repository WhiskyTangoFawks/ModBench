using System.Collections.Concurrent;

namespace MEditService.SourceAdapter;

/// <summary>What git said a file held at the last commit, kept per source folder until the last commit moves (ADR-0007).</summary>
internal sealed class CommittedTexts
{
    private sealed record Kept(string Commit)
    {
        internal ConcurrentDictionary<string, string?> Texts { get; } = new(StringComparer.Ordinal);
    }

    private readonly ConcurrentDictionary<string, Kept> _kept = new(StringComparer.Ordinal);

    /// <summary>The text of <paramref name="relativePath"/> at the last commit, or null when it holds none.</summary>
    internal string? Of(string sourceFolder, SourceRepositoryGit git, string relativePath)
    {
        if (!SourceRepositoryGit.HoldsSourceMod(sourceFolder) || (git.LastCommit() ?? git.HeadCommit()) is not { } commit) return null;

        var kept = _kept.AddOrUpdate(sourceFolder, _ => new Kept(commit), (_, held) => held.Commit == commit ? held : new Kept(commit));
        return kept.Texts.GetOrAdd(relativePath, path => git.ReadCommittedSourceText(path));
    }
}
