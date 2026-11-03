using System.Text;
using System.Text.Json.Serialization;
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

/// <summary>Which repository holds the source folder version in git makes (plugins.md, Version in git, story 1).</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SourceModIn
{
    /// <summary>A repository of its own, made in the source folder.</summary>
    NewRepository,

    /// <summary>The modlist repository, which the source folder sits in.</summary>
    ModlistRepository,
}

/// <summary>Puts a mod's source folder under git, with one commit, <c>Init &lt;mod&gt;</c>, of its paths alone when
/// asked. A failed init writes nothing and deletes no repository it did not make (ADR-0003).</summary>
internal static class GitInit
{
    internal static void Init(
        string sourceFolder, byte[] buildFile, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins,
        IReadOnlyList<FileToCopy> assets, bool commit, (PluginAddress Plugin, TreeCommit Commit)? repair, RootFile? manifest = null,
        IReadOnlyList<string>? ignored = null, SourceModIn heldIn = SourceModIn.NewRepository)
    {
        if (SourceRepositoryGit.HoldsSourceMod(sourceFolder) || SourceRepositoryGit.HoldsAnotherRepository(sourceFolder))
            throw new InvalidOperationException($"'{sourceFolder}' is already a source mod's source folder, or holds a repository.");
        if (!commit && repair is not null)
            throw new ArgumentException("A repair is a commit, so an init that commits nothing cannot hold one.", nameof(repair));
        var git = heldIn == SourceModIn.NewRepository ? SourceRepositoryGit.Own(sourceFolder) : SourceRepositoryGit.Holding(sourceFolder);
        if (heldIn == SourceModIn.ModlistRepository && !git.Exists)
            throw SourceStopException.Inaccessible($"no repository holds '{sourceFolder}', so it cannot be put in the modlist repository");

        WriteJournal journal = new(sourceFolder);
        try
        {
            journal.CreateDirectory(sourceFolder);
            WriteEachPlugin(sourceFolder, plugins, journal);
            foreach (var asset in assets)
                journal.Copy(Path.Combine(sourceFolder, asset.Path), asset.Open);
            if (heldIn == SourceModIn.NewRepository)
            {
                if (!git.Exists)
                    journal.RecordUndo(() => { if (git.Exists) git.Delete(); }, path: git.GitDirectory);
                CreateRepository(git);
            }
            journal.Write(Path.Combine(sourceFolder, ".gitignore"), Encoding.UTF8.GetBytes(GitignoreContent(manifest, assets, ignored ?? [])));
            journal.Write(Path.Combine(sourceFolder, SourceRepositoryLayout.BuildFileName), buildFile);
            if (manifest is not null) journal.Write(Path.Combine(sourceFolder, manifest.Name), manifest.Content);
            if (heldIn == SourceModIn.ModlistRepository)
            {
                var head = git.HeadCommit();
                journal.RecordUndo(() => git.PutBack(head), description: $"what the modlist repository holds of '{sourceFolder}'");
            }
            Track(git, journal, sourceFolder, commit, plugins, repair);
            if (heldIn == SourceModIn.NewRepository)
                git.Run("config", $"{SourceRepositoryGit.InitMarkSection}.{SourceRepositoryGit.InitMarkKey}", SourceRepositoryGit.InitDone);
        }
        catch (Exception ex)
        {
            if (journal.Report(ex, journal.UndoSince(0)) is { } report) throw report;
            throw;
        }
    }

    // The modlist repository holds more than the source folder, so a commit there names the folder's paths.
    private static void Track(
        SourceRepositoryGit git, WriteJournal journal, string sourceFolder, bool commit,
        IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins, (PluginAddress Plugin, TreeCommit Commit)? repair)
    {
        string[] paths = git.IsOwn ? [] : ["--", "."];
        git.Run(["add", "-A", .. paths]);
        if (commit)
        {
            git.Run(["commit", "-q", "-m", $"Init {SourceRepositoryLayout.ModNameIn(sourceFolder)}", .. paths]);
            if (repair is var (repaired, repairCommit))
            {
                SourceRepositoryWrites.ReplaceTree(journal, sourceFolder, repaired.Name, SourceRepositoryLayout.PristineFilesOf(repaired.Name, repairCommit.Tree));
                git.Run(["add", "-A", .. paths]);
                git.Run(["commit", "-q", "-m", repairCommit.Message, .. paths]);
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
