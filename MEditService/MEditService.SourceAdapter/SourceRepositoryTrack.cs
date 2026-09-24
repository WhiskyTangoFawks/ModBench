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
    /// <summary>Track's git mechanics: <c>Track &lt;mod&gt;</c>, one baseline commit per plugin with its
    /// last-compile ref there, then the edit branch checked out. A failure removes .git, the .gitignore
    /// and the source tree.</summary>
    public static void Track(
        string modFolder, SourcePreset preset,
        IReadOnlyList<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)> baselines)
    {
        GitCli.EnsureOnPath();

        // Refused before touching git: the cleanup below would delete a real, already-tracked repo on its
        // first failure.
        if (IsTracked(modFolder))
            throw new SourceAlreadyTrackedException($"'{modFolder}' is already tracked.");

        var gitDir = Path.Combine(modFolder, ".git");
        try
        {
            GitCli.Run(gitDir, modFolder, "init", "-q", "-b", "main");
            GitCli.Run(gitDir, modFolder, "config", "core.autocrlf", "false");
            GitCli.Run(gitDir, modFolder, "config", "commit.gpgsign", "false");
            GitCli.Run(gitDir, modFolder, "config", "gc.autoDetach", "false");
            // Flat file names routinely carry a space; git's default quotePath=true C-quotes such paths in
            // porcelain output, and every porcelain reader here expects the raw path. Set once where every
            // repo is born.
            GitCli.Run(gitDir, modFolder, "config", "core.quotePath", "false");
            EnsureCommitIdentity(gitDir, modFolder);

            File.WriteAllText(Path.Combine(modFolder, ".gitignore"), GitignoreContent(preset));
            GitCli.Run(gitDir, modFolder, "add", "-A");
            GitCli.Run(gitDir, modFolder, "commit", "-q", "-m", $"Track {ModNameOf(modFolder)}");

            foreach (var (files, trailers) in baselines)
            {
                PristineFileWriter.WriteAll(files, modFolder);
                CommitBaselineToMain(gitDir, modFolder, TrackSubject(trailers), trailers);
            }

            GitCli.Run(gitDir, modFolder, "checkout", "-q", "-b", EditBranchName);
            // The baselines went to main past the real index, which catches up here; the working tree
            // already holds every byte they committed.
            GitCli.Run(gitDir, modFolder, "reset", "-q");
        }
        catch
        {
            // Cleaning up .git alone would orphan the .gitignore and the source tree, both written before the
            // commit that makes them real.
            if (Directory.Exists(gitDir)) Directory.Delete(gitDir, recursive: true);
            var gitignorePath = Path.Combine(modFolder, ".gitignore");
            if (File.Exists(gitignorePath)) File.Delete(gitignorePath);
            var sourceRoot = Path.Combine(modFolder, RootFolderName);
            if (Directory.Exists(sourceRoot)) Directory.Delete(sourceRoot, recursive: true);
            throw;
        }
    }

    /// <summary>Absorb's git mechanics: each plugin's new baseline on main, then every changed tracked
    /// file in one commit. By plumbing, so the edit branch, its index and its working tree are
    /// untouched.</summary>
    public static void CommitPristineToMain(
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
                PristineFileWriter.WriteAll(files, scratchDir);
                CommitBaselineToMain(gitDir, scratchDir, UpdateSubject(trailers), trailers);
            }
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }

        // A deleted file is missing from the work tree, so `add -A` stages its removal.
        if (trackedFileChanges is { Count: > 0 } changes)
        {
            CommitToMain(
                gitDir, modFolder, [.. changes.Select(c => ToGitPath(c.RelativePath))], $"Update {ModNameOf(modFolder)}");
        }
    }

    // One plugin's baseline, the unit every Track and update commits: its source subtree as the work
    // tree holds it, and its last-compile ref parked at the commit.
    private static void CommitBaselineToMain(string gitDir, string workTree, string subject, BaselineTrailers trailers)
    {
        var commitSha = CommitToMain(
            gitDir, workTree, [$":(literal){ToGitPath(RootFor(trailers.Plugin))}"], BaselineMessage(subject, trailers));
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

    private static string ModNameOf(string modFolder) => Path.GetFileName(Path.TrimEndingDirectorySeparator(modFolder));

    /// <summary>The trailers of the plugin's own latest baseline commit on refs/heads/main, never HEAD:
    /// the edit branch is what is checked out (ADR-0007). Null when untracked or when main holds no
    /// baseline of it.</summary>
    public static BaselineTrailers? LatestBaselineTrailers(string modFolder, string plugin)
    {
        if (!IsTracked(modFolder)) return null;

        var gitDir = Path.Combine(modFolder, ".git");
        // git's own trailer parser, so a "Plugin: " line in a message's prose is never read as one.
        if (!GitCli.TryRun(gitDir, modFolder, out var blocks, "log", "-z", "--format=%(trailers:only,unfold)", "refs/heads/main"))
            return null;

        return blocks.Split('\0', StringSplitOptions.RemoveEmptyEntries)
            .Where(block => string.Equals(ReadTrailer(block, "Plugin"), plugin, StringComparison.OrdinalIgnoreCase))
            .Select(block => new BaselineTrailers(
                plugin, ReadTrailer(block, "Upstream-Version"), ReadTrailer(block, "Meta-SHA256"), ReadTrailer(block, "Binary-SHA256")))
            .FirstOrDefault();
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
