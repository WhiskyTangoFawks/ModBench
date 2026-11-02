using System.Text;
using System.Text.RegularExpressions;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>A plugin whose source init writes, and the hash of the binary it was decompiled from.</summary>
public sealed record DecompiledPlugin(PluginAddress Address, string? BinarySha256);

/// <summary>A file to copy, by its forward-slash path in the folder it is copied into.</summary>
public sealed record FileToCopy(string Path, Func<Stream> Open);

/// <summary>A file at the root of a new repository, by its name there.</summary>
public sealed record RootFile(string Name, byte[] Content);

/// <summary>Makes a mod's repository: one commit, <c>Init &lt;mod&gt;</c>, on <c>main</c>, or none when asked. An init that
/// fails writes nothing and never deletes a repository it did not make (ADR-0003).</summary>
internal static class GitInit
{
    internal static void Init(
        string sourceFolder, byte[] buildFile, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins,
        IReadOnlyList<FileToCopy> assets, bool commit, (PluginAddress Plugin, TreeCommit Commit)? repair, RootFile? manifest = null,
        IReadOnlyList<string>? ignored = null)
    {
        if (SourceRepositoryGit.HoldsRepository(sourceFolder) || SourceRepositoryGit.HoldsAnotherRepository(sourceFolder))
            throw new InvalidOperationException($"'{sourceFolder}' already holds a repository.");
        if (!commit && repair is not null)
            throw new ArgumentException("A repair is a commit, so an init that commits nothing cannot hold one.", nameof(repair));

        WriteJournal journal = new(sourceFolder);
        var git = new SourceRepositoryGit(sourceFolder);
        try
        {
            journal.CreateDirectory(sourceFolder);
            WriteEachPlugin(sourceFolder, plugins, journal);
            foreach (var asset in assets)
                journal.Copy(Path.Combine(sourceFolder, asset.Path), asset.Open);
            if (!git.Exists)
                journal.RecordUndo(() => { if (git.Exists) git.Delete(); }, path: git.GitDirectory);
            CreateRepository(git);
            journal.Write(Path.Combine(sourceFolder, ".gitignore"), Encoding.UTF8.GetBytes(GitignoreContent(manifest, assets, ignored ?? [])));
            journal.Write(Path.Combine(sourceFolder, SourceRepositoryLayout.BuildFileName), buildFile);
            if (manifest is not null) journal.Write(Path.Combine(sourceFolder, manifest.Name), manifest.Content);
            Track(git, journal, sourceFolder, commit, plugins, repair);
            git.Run("config", $"{SourceRepositoryGit.InitMarkSection}.{SourceRepositoryGit.InitMarkKey}", SourceRepositoryGit.InitDone);
        }
        catch (Exception ex)
        {
            if (journal.Report(ex, journal.UndoSince(0)) is { } report) throw report;
            throw;
        }
    }

    private static void Track(
        SourceRepositoryGit git, WriteJournal journal, string sourceFolder, bool commit,
        IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins, (PluginAddress Plugin, TreeCommit Commit)? repair)
    {
        git.Run("add", "-A");
        if (commit)
        {
            git.Run("commit", "-q", "-m", $"Init {SourceRepositoryLayout.ModNameIn(sourceFolder)}");
            if (repair is var (repaired, repairCommit))
            {
                SourceRepositoryWrites.ReplaceTree(journal, sourceFolder, repaired.Name, SourceRepositoryLayout.PristineFilesOf(repaired.Name, repairCommit.Tree));
                git.Run("add", "-A");
                git.Run("commit", "-q", "-m", repairCommit.Message);
            }
        }
        foreach (var (_, plugin) in plugins)
        {
            if (plugin.BinarySha256 is { } binarySha256) git.ParkDecompiled(plugin.Address.Name, binarySha256);
        }
    }

    private static void WriteEachPlugin(
        string workTree, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins, WriteJournal journal)
    {
        foreach (var (tree, plugin) in plugins)
        {
            try
            {
                journal.WriteAll(tree.Select(file => SourceRepositoryLayout.PlacedFileOf(plugin.Address.Name, file)), workTree);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                throw new IOException($"{plugin.Address.Name}'s source could not be written: {ex.Message}", ex);
            }
        }
    }

    private static void CreateRepository(SourceRepositoryGit git)
    {
        git.Run("init", "-q", "-b", "main");
        git.Run("config", $"{SourceRepositoryGit.InitMarkSection}.{SourceRepositoryGit.InitMarkKey}", SourceRepositoryGit.InitPending);
        foreach (var (key, value) in Settings) git.Run("config", key, value);
        EnsureCommitIdentity(git);
    }

    /// <summary>How Modbench sets every source repository it makes, by init or by clone.</summary>
    internal static readonly (string Key, string Value)[] Settings =
    [
        ("core.autocrlf", "false"),
        // Git for Windows refuses a path past 260 characters unless told otherwise, and a source folder's
        // plugin source nests deep.
        ("core.longpaths", "true"),
        ("commit.gpgsign", "false"),
        ("gc.autoDetach", "false"),
        // Plugin file names carry spaces, which git's default quotePath C-quotes in porcelain output,
        // and every porcelain reader here expects the raw path.
        ("core.quotePath", "false"),
    ];

    // Pins a repo-local identity only when the global one is unset; never overwrites a real identity.
    internal static void EnsureCommitIdentity(SourceRepositoryGit git)
    {
        if (!git.TryRun(out _, "config", "--get", "user.name"))
            git.Run("config", "user.name", "Modbench");
        if (!git.TryRun(out _, "config", "--get", "user.email"))
            git.Run("config", "user.email", "modbench@localhost");
    }

    // Root-anchored, so no same-named folder deeper is un-ignored. An un-ignore outranks the user's global
    // excludes. The ignored paths come last: a package yields them (ADR-0022).
    private static string GitignoreContent(RootFile? manifest, IReadOnlyList<FileToCopy> assets, IReadOnlyList<string> ignored) =>
        "*\n" +
        "!/.gitignore\n" +
        $"!/{SourceRepositoryLayout.BuildFileName}\n" +
        Unignored($"{SourceRepositoryLayout.RootFolderName}/") +
        (manifest is null ? "" : $"!/{Escaped(manifest.Name)}\n") +
        string.Concat(assets.Select(asset => RootEntryOf(asset.Path)).Distinct(StringComparer.Ordinal).Select(Unignored)) +
        string.Concat(ignored.Select(path => $"/{Escaped(path)}\n"));

    private static string RootEntryOf(string path) => path.Split('/') is [var file] ? Escaped(file) : $"{Escaped(path.Split('/')[0])}/";

    private static string Unignored(string entry) => entry.EndsWith('/') ? $"!/{entry}\n!/{entry}**\n" : $"!/{entry}\n";

    private static string Escaped(string path) => Regex.Replace(path, @"[\\*?\[\]#! ]", @"\$0");
}
