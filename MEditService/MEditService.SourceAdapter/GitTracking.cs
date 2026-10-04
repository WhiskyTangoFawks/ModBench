using MEditService.Codec.Serialization;

namespace MEditService.SourceAdapter;

/// <summary>One plugin's facts as its baseline commit's trailers carry them (ADR-0007),
/// on the write side and the read side alike. A fact with no value is left out of the commit.</summary>
public sealed record BaselineTrailers(string Plugin, string? UpstreamVersion, string? BinarySha256);

/// <summary>The two <c>.gitignore</c> presets (plugins.md, Track, story 2).</summary>
public enum SourcePreset
{
    Edits,
    Everything,
}

/// <summary>Makes a mod's repository: <c>Track &lt;mod&gt;</c>, then one baseline commit per plugin on
/// <c>main</c>, which stays checked out.</summary>
internal static class GitTracking
{
    /// <summary>Answers each plugin whose commit failed.</summary>
    internal static IReadOnlyList<(string Plugin, string Reason)> Track(
        string modFolder, SourcePreset preset,
        IReadOnlyList<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)> baselines)
    {
        SourceRepositoryGit.EnsureOnPath();
        if (SourceRepositoryGit.IsTracked(modFolder) || SourceRepositoryGit.HoldsAnotherRepository(modFolder))
            throw new InvalidOperationException($"'{modFolder}' already holds a repository.");

        var git = new SourceRepositoryGit(modFolder);
        CreateRepository(git, modFolder, preset);
        var refused = CommitEachBaseline(git, modFolder, baselines);
        // The baselines were committed through a scratch index, so the real one catches up with main.
        git.Run("reset", "-q");
        return refused;
    }

    // No rollback beyond git's: the commits before a failed one stand, and git's own clean takes the
    // failed plugin's files back out of the work tree.
    private static List<(string Plugin, string Reason)> CommitEachBaseline(
        SourceRepositoryGit git, string workTree, IReadOnlyList<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)> baselines)
    {
        var refused = new List<(string Plugin, string Reason)>();
        foreach (var (files, trailers) in baselines)
        {
            try
            {
                PristineFileWriter.WriteAll(files, workTree);
                git.ParkBaseline(trailers.Plugin, CommitToMain(
                    git, [SourceRepositoryGit.LiteralPathspec(SourceRepositoryLayout.RootFor(trailers.Plugin))],
                    BaselineMessage(TrackSubject(trailers), trailers)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                git.Run("clean", "-fdq", "--", SourceRepositoryGit.LiteralPathspec(SourceRepositoryLayout.RootFor(trailers.Plugin)));
                refused.Add((trailers.Plugin, ex.Message));
            }
        }
        return refused;
    }

    private static void CreateRepository(SourceRepositoryGit git, string modFolder, SourcePreset preset)
    {
        git.Run("init", "-q", "-b", "main");
        git.Run("config", "core.autocrlf", "false");
        git.Run("config", "commit.gpgsign", "false");
        git.Run("config", "gc.autoDetach", "false");
        // Plugin file names carry spaces, which git's default quotePath C-quotes in porcelain output,
        // and every porcelain reader here expects the raw path.
        git.Run("config", "core.quotePath", "false");
        EnsureCommitIdentity(git);

        File.WriteAllText(Path.Combine(modFolder, ".gitignore"), GitignoreContent(preset));
        git.Run("add", "-A");
        git.Run("commit", "-q", "-m", $"Track {SourceRepositoryLayout.ModNameIn(modFolder)}");
    }

    // main's own tree with just the pathspecs restaged from the work tree, through a scratch index:
    // another tool, such as VS Code's own git, may hold the real one's lock on the repository (ADR-0003).
    private static string CommitToMain(SourceRepositoryGit git, string[] pathspecs, string message)
    {
        var scratchIndex = Path.Combine(Path.GetTempPath(), $"medit-main-index-{Guid.NewGuid():N}");
        try
        {
            var parentSha = git.Run("rev-parse", "refs/heads/main").Trim();
            git.RunWithIndex(scratchIndex, "read-tree", parentSha);
            git.RunWithIndex(scratchIndex, ["add", "-A", "--", .. pathspecs]);
            var treeSha = git.RunWithIndex(scratchIndex, "write-tree").Trim();
            var commitSha = git.Run("commit-tree", treeSha, "-p", parentSha, "-m", message).Trim();
            // The old value makes the move conditional, so a main another tool moved in between is not
            // overwritten (ADR-0003).
            git.Run("update-ref", "refs/heads/main", commitSha, parentSha);
            return commitSha;
        }
        finally
        {
            if (File.Exists(scratchIndex)) File.Delete(scratchIndex);
        }
    }

    private static string TrackSubject(BaselineTrailers trailers) =>
        trailers.UpstreamVersion is { } version ? $"Track {trailers.Plugin} {version}" : $"Track {trailers.Plugin}";

    // git's message convention: the subject, a blank line, then the trailer block. commit-tree is
    // plumbing with no --trailer flag, so the block is written here.
    private static string BaselineMessage(string subject, BaselineTrailers trailers)
    {
        List<string> lines = [subject, "", $"Plugin: {trailers.Plugin}"];
        if (trailers.UpstreamVersion is { } upstreamVersion) lines.Add($"Upstream-Version: {upstreamVersion}");
        if (trailers.BinarySha256 is { } binarySha256) lines.Add($"Binary-SHA256: {binarySha256}");
        return string.Join('\n', lines) + "\n";
    }

    // Pins a repo-local identity only when the global one is unset; never overwrites a real identity.
    private static void EnsureCommitIdentity(SourceRepositoryGit git)
    {
        if (!git.TryRun(out _, "config", "--get", "user.name"))
            git.Run("config", "user.name", "Modbench");
        if (!git.TryRun(out _, "config", "--get", "user.email"))
            git.Run("config", "user.email", "modbench@localhost");
    }

    private static string GitignoreContent(SourcePreset preset) => preset switch
    {
        // Root-anchored: a bare "plugin-source/" would also un-ignore a same-named folder nested
        // anywhere else in the mod.
        SourcePreset.Edits =>
            "# Generated by Track (Edits preset) — mEdit never rewrites this file after Track.\n" +
            "*\n" +
            $"!/{SourceRepositoryLayout.RootFolderName}/\n" +
            $"!/{SourceRepositoryLayout.RootFolderName}/**\n" +
            "!.gitignore\n" +
            "meta.ini\n",
        // Root-anchored: plugin binaries only ever live at the mod folder root.
        SourcePreset.Everything =>
            "# Generated by Track (Everything preset) — mEdit never rewrites this file after Track.\n" +
            "/*.esp\n" +
            "/*.esm\n" +
            "/*.esl\n" +
            "meta.ini\n",
        _ => throw new ArgumentOutOfRangeException(nameof(preset), preset, "Unknown source preset."),
    };
}

/// <summary>The one way a list of <see cref="TreeFile"/>s becomes real files under a base
/// directory, shared so the call sites cannot drift.</summary>
internal static class PristineFileWriter
{
    internal static void WriteAll(IEnumerable<TreeFile> files, string baseDirectory)
    {
        foreach (var file in files)
        {
            var fullPath = Path.Combine(baseDirectory, file.RelativePath);
            Directory.CreateDirectory(PathShape.DirectoryOf(fullPath));
            File.WriteAllBytes(fullPath, file.Content);
        }
    }
}
