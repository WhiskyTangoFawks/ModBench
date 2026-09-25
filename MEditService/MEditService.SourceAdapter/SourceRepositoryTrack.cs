using MEditService.Codec.Serialization;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

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

/// <summary>One plugin's facts as its baseline commit's trailers carry them (ADR-0007 invariant 6),
/// on the write side and the read side alike. A fact with no value is left out of the commit.</summary>
public sealed record BaselineTrailers(string Plugin, string? UpstreamVersion, string? MetaSha256, string? BinarySha256);

/// <summary>The two <c>.gitignore</c> presets ADR-0007 names: Edits tracks source only; Everything
/// additionally tracks assets. Plugin binaries and <c>meta.ini</c> are ignored in both.</summary>
public enum SourcePreset
{
    Edits,
    Everything,
}

public sealed partial class SourceRepository
{
    /// <summary>One baseline commit per plugin on <c>main</c>, answering each plugin whose commit
    /// failed. A mod with no repository gets one: <c>Track &lt;mod&gt;</c> first, the edit branch
    /// checked out last.</summary>
    public static IReadOnlyList<(string Plugin, string Reason)> Track(
        string modFolder, SourcePreset preset,
        IReadOnlyList<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)> baselines)
    {
        GitCli.EnsureOnPath();
        var gitDir = Path.Combine(modFolder, ".git");
        if (IsTracked(modFolder)) return JoinRepository(gitDir, baselines);
        if (HoldsAnotherRepository(modFolder))
            throw new InvalidOperationException($"'{modFolder}' holds a repository with history but no main branch.");

        CreateRepository(gitDir, modFolder, preset);
        var refused = CommitEachBaseline(gitDir, modFolder, baselines);
        GitCli.Run(gitDir, modFolder, "checkout", "-q", "-b", EditBranchName);
        GitCli.Run(gitDir, modFolder, "reset", "-q");
        return refused;
    }

    // A scratch work tree: the edit branch does not move, and a baseline written into the real one
    // would stand in the way of `rebase edit branch` as untracked files.
    private static List<(string Plugin, string Reason)> JoinRepository(
        string gitDir, IReadOnlyList<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)> baselines)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-track-").FullName;
        try
        {
            return CommitEachBaseline(gitDir, scratchDir, baselines);
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }

    // No rollback beyond git's: the commits before a failed one stand, and git's own clean takes the
    // failed plugin's files back out of the work tree.
    private static List<(string Plugin, string Reason)> CommitEachBaseline(
        string gitDir, string workTree, IReadOnlyList<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)> baselines)
    {
        var refused = new List<(string Plugin, string Reason)>();
        foreach (var (files, trailers) in baselines)
        {
            try
            {
                PristineFileWriter.WriteAll(files, workTree);
                CommitBaselineToMain(gitDir, workTree, TrackSubject(trailers), trailers);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                GitCli.Run(gitDir, workTree, "clean", "-fdq", "--", LiteralPathspec(RootFor(trailers.Plugin)));
                refused.Add((trailers.Plugin, ex.Message));
            }
        }
        return refused;
    }

    private static void CreateRepository(string gitDir, string modFolder, SourcePreset preset)
    {
        GitCli.Run(gitDir, modFolder, "init", "-q", "-b", "main");
        GitCli.Run(gitDir, modFolder, "config", "core.autocrlf", "false");
        GitCli.Run(gitDir, modFolder, "config", "commit.gpgsign", "false");
        GitCli.Run(gitDir, modFolder, "config", "gc.autoDetach", "false");
        // Plugin file names carry spaces, which git's default quotePath C-quotes in porcelain output,
        // and every porcelain reader here expects the raw path.
        GitCli.Run(gitDir, modFolder, "config", "core.quotePath", "false");
        EnsureCommitIdentity(gitDir, modFolder);

        File.WriteAllText(Path.Combine(modFolder, ".gitignore"), GitignoreContent(preset));
        GitCli.Run(gitDir, modFolder, "add", "-A");
        GitCli.Run(gitDir, modFolder, "commit", "-q", "-m", $"Track {ModNameIn(modFolder)}");
    }

    /// <summary>Absorb's git mechanics, by plumbing so the edit branch is untouched: each plugin's
    /// baseline on main, then the changed tracked files in one commit. The first failure stops the
    /// run and is answered with the commit's subject and what failed.</summary>
    public static (string Subject, string Reason)? CommitPristineToMain(
        string modFolder,
        IReadOnlyList<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)> baselines,
        IReadOnlyList<TrackedFileChange>? trackedFileChanges = null)
    {
        GitCli.EnsureOnPath();
        var gitDir = Path.Combine(modFolder, ".git");

        // A scratch work tree: the real one holds the edit branch, and may hold the user's own dirt.
        var scratchDir = Directory.CreateTempSubdirectory("medit-absorb-").FullName;
        try
        {
            foreach (var (files, trailers) in baselines)
            {
                var subject = UpdateSubject(trailers);
                var commitSha = string.Empty;
                if (FailureOf(() =>
                    {
                        PristineFileWriter.WriteAll(files, scratchDir);
                        commitSha = CommitToMain(
                            gitDir, scratchDir, [LiteralPathspec(RootFor(trailers.Plugin))], BaselineMessage(subject, trailers));
                    }) is { } commitFailure)
                    return (subject, $"could not be committed to main: {commitFailure}");
                if (FailureOf(() => GitCli.Run(gitDir, scratchDir, "update-ref", LastCompileRef(trailers.Plugin), commitSha))
                    is { } refFailure)
                    return (subject, $"landed on main, but {LastCompileRef(trailers.Plugin)} could not be moved to it: {refFailure}");
            }
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }

        // A deleted file is missing from the work tree, so `add -A` stages its removal.
        if (trackedFileChanges is { Count: > 0 } changes)
        {
            var subject = $"Update {ModNameIn(modFolder)}";
            var failure = FailureOf(() => CommitToMain(gitDir, modFolder, [.. changes.Select(c => LiteralPathspec(c.RelativePath))], subject));
            if (failure is { } reason) return (subject, $"could not be committed to main: {reason}");
        }
        return null;
    }

    // No rollback beyond git's: the commits before a failed one stand.
    private static string? FailureOf(Action step)
    {
        try
        {
            step();
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or GitCommandFailedException)
        {
            return ex.Message.Trim();
        }
    }

    private static void CommitBaselineToMain(string gitDir, string workTree, string subject, BaselineTrailers trailers)
    {
        var commitSha = CommitToMain(
            gitDir, workTree, [LiteralPathspec(RootFor(trailers.Plugin))], BaselineMessage(subject, trailers));
        GitCli.Run(gitDir, workTree, "update-ref", LastCompileRef(trailers.Plugin), commitSha);
    }

    // main's own tree with just the pathspecs restaged from the work tree, through a scratch index: the
    // real one may hold the user's own staged dirt.
    private static string CommitToMain(string gitDir, string workTree, string[] pathspecs, string message)
    {
        var scratchIndex = Path.Combine(Path.GetTempPath(), $"medit-main-index-{Guid.NewGuid():N}");
        try
        {
            var parentSha = GitCli.Run(gitDir, workTree, "rev-parse", "refs/heads/main").Trim();
            GitCli.RunWithIndex(gitDir, workTree, scratchIndex, "read-tree", parentSha);
            GitCli.RunWithIndex(gitDir, workTree, scratchIndex, ["add", "-A", "--", .. pathspecs]);
            var treeSha = GitCli.RunWithIndex(gitDir, workTree, scratchIndex, "write-tree").Trim();

            var commitSha = GitCli.Run(gitDir, workTree, "commit-tree", treeSha, "-p", parentSha, "-m", message).Trim();
            // The old value makes the move conditional, so a main another tool moved in between is not
            // overwritten (ADR-0003).
            GitCli.Run(gitDir, workTree, "update-ref", "refs/heads/main", commitSha, parentSha);
            return commitSha;
        }
        finally
        {
            if (File.Exists(scratchIndex)) File.Delete(scratchIndex);
        }
    }

    // Plugin and asset file names carry brackets and asterisks, which git otherwise reads as a glob.
    private static string LiteralPathspec(string relativePath) => $":(literal){ToGitPath(relativePath)}";

    private static string TrackSubject(BaselineTrailers trailers) =>
        trailers.UpstreamVersion is { } version ? $"Track {trailers.Plugin} {version}" : $"Track {trailers.Plugin}";

    private static string UpdateSubject(BaselineTrailers trailers) =>
        trailers.UpstreamVersion is { } version ? $"Update {trailers.Plugin} to {version}" : $"Update {trailers.Plugin}";

    // git's message convention: the subject, a blank line, then the trailer block. commit-tree is
    // plumbing with no --trailer flag, so the block is written here.
    private static string BaselineMessage(string subject, BaselineTrailers trailers)
    {
        List<string> lines = [subject, "", $"Plugin: {trailers.Plugin}"];
        if (trailers.UpstreamVersion is { } upstreamVersion) lines.Add($"Upstream-Version: {upstreamVersion}");
        if (trailers.MetaSha256 is { } metaSha256) lines.Add($"Meta-SHA256: {metaSha256}");
        if (trailers.BinarySha256 is { } binarySha256) lines.Add($"Binary-SHA256: {binarySha256}");
        return string.Join('\n', lines) + "\n";
    }

    /// <summary>Each named plugin's own latest baseline on refs/heads/main, never the checked-out edit
    /// branch (ADR-0007), the newest commit first. A plugin main holds no baseline of is left out.</summary>
    public static IReadOnlyList<BaselineTrailers> LatestBaselineTrailersNewestFirst(string modFolder, IReadOnlyList<string> plugins)
    {
        if (!IsTracked(modFolder)) return [];

        var gitDir = Path.Combine(modFolder, ".git");
        // git's own trailer parser, so a "Plugin: " line in a message's prose is never read as one.
        if (!GitCli.TryRun(gitDir, modFolder, out var blocks, "log", "-z", "--format=%(trailers:only,unfold)", "refs/heads/main"))
            return [];

        var latest = new List<BaselineTrailers>();
        foreach (var block in blocks.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            var named = ReadTrailer(block, "Plugin");
            var plugin = plugins.FirstOrDefault(p => string.Equals(p, named, StringComparison.OrdinalIgnoreCase));
            if (plugin is null || latest.Exists(baseline => baseline.Plugin == plugin)) continue;
            latest.Add(new BaselineTrailers(
                plugin, ReadTrailer(block, "Upstream-Version"), ReadTrailer(block, "Meta-SHA256"), ReadTrailer(block, "Binary-SHA256")));
        }
        return latest;
    }

    // Last matching line wins — git's own rule for a repeated trailer key.
    private static string? ReadTrailer(string body, string key)
    {
        var prefix = $"{key}: ";
        return body.Split('\n')
            .Where(line => line.StartsWith(prefix, StringComparison.Ordinal))
            .Select(line => line[prefix.Length..].Trim())
            .LastOrDefault();
    }

    /// <summary>The checked-out branch edits live on (CONTEXT.md's "Edit branch") — one fixed name, since
    /// a mod folder can hold more than one plugin.</summary>
    internal const string EditBranchName = "edit";

    // Pins a repo-local identity only when the global one is unset; never overwrites a real identity.
    private static void EnsureCommitIdentity(string gitDir, string workTree)
    {
        if (!GitCli.TryRun(gitDir, workTree, out _, "config", "--get", "user.name"))
            GitCli.Run(gitDir, workTree, "config", "user.name", "Modbench");
        if (!GitCli.TryRun(gitDir, workTree, out _, "config", "--get", "user.email"))
            GitCli.Run(gitDir, workTree, "config", "user.email", "modbench@localhost");
    }

    // meta.ini is never tracked content (ADR-0003) and plugin binaries are the compiled
    // artifact; both are ignored in every preset.
    private static string GitignoreContent(SourcePreset preset) => preset switch
    {
        // Root-anchored: a bare "source/" would also swallow a mod's own Scripts/Source/*.psc.
        SourcePreset.Edits =>
            "# Generated by Track (Edits preset) — mEdit never rewrites this file after Track.\n" +
            "*\n" +
            $"!/{RootFolderName}/\n" +
            $"!/{RootFolderName}/**\n" +
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
