using MEditService.Codec.Serialization;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>A plugin whose source Track writes, and the hash of the binary it was decompiled from.</summary>
public sealed record DecompiledPlugin(string Plugin, string? BinarySha256);

/// <summary>Makes a mod's repository: one commit, <c>Track &lt;mod&gt;</c>, on <c>main</c>. A track that
/// refuses any plugin writes nothing, and it never deletes a repository it did not make (ADR-0003).</summary>
internal static class GitTracking
{
    /// <summary>Answers each plugin whose files could not be written.</summary>
    internal static IReadOnlyList<(string Plugin, string Reason)> Track(
        string modFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Files, DecompiledPlugin Plugin)> plugins)
    {
        GitCli.EnsureOnPath();
        if (SourceRepositoryGit.IsTracked(modFolder) || SourceRepositoryGit.HoldsAnotherRepository(modFolder))
            throw new InvalidOperationException($"'{modFolder}' already holds a repository.");

        WriteLog log = new();
        var (written, refused) = WriteEachPlugin(modFolder, plugins, log);
        if (refused.Count > 0)
        {
            var left = log.UndoSince(0, modFolder);
            return left.Count == 0 ? refused : [(refused[0].Plugin, $"{refused[0].Reason} {LeftStanding(left)}"), .. refused.Skip(1)];
        }

        var git = new SourceRepositoryGit(modFolder);
        var gitignorePath = Path.Combine(modFolder, ".gitignore");
        var gitignoreBefore = File.Exists(gitignorePath) ? File.ReadAllBytes(gitignorePath) : null;
        var repositoryExisted = git.Exists;
        try
        {
            CreateRepository(git);
            File.WriteAllText(gitignorePath, GitignoreContent);
            git.Run("add", "-A");
            git.Run("commit", "-q", "-m", $"Track {SourceRepositoryLayout.ModNameIn(modFolder)}");
            foreach (var plugin in written)
            {
                if (plugin.BinarySha256 is { } binarySha256) git.ParkDecompiled(plugin.Plugin, binarySha256);
            }
        }
        catch (Exception ex)
        {
            if (!repositoryExisted && git.Exists) git.Delete();
            if (gitignoreBefore is null) File.Delete(gitignorePath);
            else File.WriteAllBytes(gitignorePath, gitignoreBefore);
            var left = log.UndoSince(0, modFolder);
            if (left.Count == 0) throw;
            throw new IOException($"{ex.Message} {LeftStanding(left)}", ex);
        }
        return [];
    }

    private static (List<DecompiledPlugin> Written, List<(string Plugin, string Reason)> Refused) WriteEachPlugin(
        string workTree, IReadOnlyList<(IReadOnlyList<TreeFile> Files, DecompiledPlugin Plugin)> plugins, WriteLog log)
    {
        List<DecompiledPlugin> written = [];
        List<(string Plugin, string Reason)> refused = [];
        foreach (var (files, plugin) in plugins)
        {
            var mark = log.Mark;
            try
            {
                PristineFileWriter.WriteAll(files, workTree, log);
                written.Add(plugin);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                var left = log.UndoSince(mark, workTree);
                refused.Add((plugin.Plugin, left.Count == 0 ? ex.Message : $"{ex.Message} {LeftStanding(left)}"));
            }
            catch (Exception ex)
            {
                var left = log.UndoSince(0, workTree);
                if (left.Count == 0) throw;
                throw new IOException($"{ex.Message} {LeftStanding(left)}", ex);
            }
        }
        return (written, refused);
    }

    private static string LeftStanding(List<string> left) => $"Left standing: {string.Join(" ", left)}";

    private static void CreateRepository(SourceRepositoryGit git)
    {
        git.Run("init", "-q", "-b", "main");
        git.Run("config", $"{SourceRepositoryGit.TrackMarkSection}.{SourceRepositoryGit.TrackMarkKey}", "true");
        git.Run("config", "core.autocrlf", "false");
        git.Run("config", "commit.gpgsign", "false");
        git.Run("config", "gc.autoDetach", "false");
        // Plugin file names carry spaces, which git's default quotePath C-quotes in porcelain output,
        // and every porcelain reader here expects the raw path.
        git.Run("config", "core.quotePath", "false");
        EnsureCommitIdentity(git);
    }

    // Pins a repo-local identity only when the global one is unset; never overwrites a real identity.
    private static void EnsureCommitIdentity(SourceRepositoryGit git)
    {
        if (!git.TryRun(out _, "config", "--get", "user.name"))
            git.Run("config", "user.name", "Modbench");
        if (!git.TryRun(out _, "config", "--get", "user.email"))
            git.Run("config", "user.email", "modbench@localhost");
    }

    // Root-anchored: a bare "plugin-source/" would also un-ignore a same-named folder nested
    // anywhere else in the mod.
    private static readonly string GitignoreContent =
        "# Generated by Track — mEdit never rewrites this file after Track.\n" +
        "*\n" +
        $"!/{SourceRepositoryLayout.RootFolderName}/\n" +
        $"!/{SourceRepositoryLayout.RootFolderName}/**\n" +
        "!.gitignore\n" +
        "meta.ini\n";
}

/// <summary>What a write made or replaced, so a rollback takes back only that: a directory once empty, a
/// file while it holds the bytes this write gave it (ADR-0003). What it leaves is named.</summary>
internal sealed class WriteLog
{
    private abstract record Entry(string Path);

    private sealed record CreatedDirectory(string Path) : Entry(Path);

    private sealed record CreatedFile(string Path, byte[] Written) : Entry(Path);

    private sealed record ReplacedFile(string Path, byte[] Original, byte[] Written) : Entry(Path);

    private readonly List<Entry> _entries = [];

    internal int Mark => _entries.Count;

    internal void CreatedDirectoryAt(string path) => _entries.Add(new CreatedDirectory(path));

    internal void Created(string path, byte[] written) => _entries.Add(new CreatedFile(path, written));

    internal void Replaced(string path, byte[] original, byte[] written) => _entries.Add(new ReplacedFile(path, original, written));

    /// <summary>Answers what it left standing, each named relative to <paramref name="relativeTo"/>.</summary>
    internal List<string> UndoSince(int mark, string relativeTo)
    {
        List<string> left = [];
        for (var i = _entries.Count - 1; i >= mark; i--)
        {
            var entry = _entries[i];
            string Name() => System.IO.Path.GetRelativePath(relativeTo, entry.Path);
            switch (entry)
            {
                case CreatedDirectory when Directory.Exists(entry.Path):
                    if (Directory.EnumerateFileSystemEntries(entry.Path).Any()) left.Add($"{Name()} holds something Modbench did not write.");
                    else Directory.Delete(entry.Path);
                    break;
                case CreatedFile created when File.Exists(entry.Path):
                    if (Holds(created.Path, created.Written)) File.Delete(created.Path);
                    else left.Add($"{Name()} was changed by another program.");
                    break;
                case ReplacedFile replaced:
                    if (!Holds(replaced.Path, replaced.Written)) left.Add($"{Name()} was changed by another program.");
                    else File.WriteAllBytes(replaced.Path, replaced.Original);
                    break;
            }
        }
        _entries.RemoveRange(mark, _entries.Count - mark);
        return left;
    }

    private static bool Holds(string path, byte[] bytes) => File.Exists(path) && File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes);
}

/// <summary>The one way a list of <see cref="TreeFile"/>s becomes real files under a base
/// directory, shared so the call sites cannot drift.</summary>
internal static class PristineFileWriter
{
    internal static void WriteAll(IEnumerable<TreeFile> files, string baseDirectory) => WriteAll(files, baseDirectory, new WriteLog());

    internal static void WriteAll(IEnumerable<TreeFile> files, string baseDirectory, WriteLog log)
    {
        foreach (var file in files)
        {
            var fullPath = Path.Combine(baseDirectory, file.RelativePath);
            var directory = PathShape.DirectoryOf(fullPath);
            var missing = new Stack<string>();
            for (var ancestor = directory; !Directory.Exists(ancestor); ancestor = PathShape.DirectoryOf(ancestor))
                missing.Push(ancestor);
            foreach (var created in missing) log.CreatedDirectoryAt(created);
            Directory.CreateDirectory(directory);
            if (File.Exists(fullPath)) log.Replaced(fullPath, File.ReadAllBytes(fullPath), file.Content);
            else log.Created(fullPath, file.Content);
            File.WriteAllBytes(fullPath, file.Content);
        }
    }
}
