using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>A plugin whose source init writes, and the hash of the binary it was decompiled from.</summary>
public sealed record DecompiledPlugin(PluginAddress Address, string? BinarySha256);

/// <summary>A file of the mod no installation file yields, by its forward-slash path in the mod folder.</summary>
public sealed record Asset(string Path, Func<Stream> Open);

/// <summary>Makes a mod's repository: one commit, <c>Init &lt;mod&gt;</c>, on <c>main</c>. An init that
/// fails writes nothing, and it never deletes a repository it did not make (ADR-0003).</summary>
internal static class GitInit
{
    internal static void Init(
        string sourceFolder, SpelledManifest manifest, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins,
        IReadOnlyList<Asset> assets, (PluginAddress Plugin, TreeCommit Commit)? repair)
    {
        if (SourceRepositoryGit.HoldsRepository(sourceFolder) || SourceRepositoryGit.HoldsAnotherRepository(sourceFolder))
            throw new InvalidOperationException($"'{sourceFolder}' already holds a repository.");

        WriteJournal journal = new(sourceFolder);
        var git = new SourceRepositoryGit(sourceFolder);
        try
        {
            WriteEachPlugin(sourceFolder, plugins, journal);
            foreach (var asset in assets)
                journal.Copy(Path.Combine(sourceFolder, SourceRepositoryLayout.AssetsFolderName, asset.Path), asset.Open);
            if (!git.Exists)
                journal.RecordUndo(() => { if (git.Exists) git.Delete(); }, path: git.GitDirectory);
            CreateRepository(git);
            journal.Write(Path.Combine(sourceFolder, ".gitignore"), Encoding.UTF8.GetBytes(GitignoreContent));
            journal.Write(Path.Combine(sourceFolder, manifest.Name), manifest.Text);
            git.Run("add", "-A");
            git.Run("commit", "-q", "-m", $"Init {SourceRepositoryLayout.ModNameIn(sourceFolder)}");
            if (repair is var (repaired, commit))
            {
                SourceRepositoryWrites.ReplaceTree(journal, sourceFolder, repaired.Name, SourceRepositoryLayout.PristineFilesOf(repaired.Name, commit.Tree));
                git.Run("add", "-A");
                git.Run("commit", "-q", "-m", commit.Message);
            }
            foreach (var (_, plugin) in plugins)
            {
                if (plugin.BinarySha256 is { } binarySha256) git.ParkDecompiled(plugin.Address.Name, binarySha256);
            }
        }
        catch (Exception ex)
        {
            if (journal.Report(ex, journal.UndoSince(0)) is { } report) throw report;
            throw;
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
        git.Run("config", $"{SourceRepositoryGit.InitMarkSection}.{SourceRepositoryGit.InitMarkKey}", "true");
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

    // Root-anchored: a bare "plugin-source/" would also un-ignore a same-named folder nested anywhere else.
    // An un-ignore here outranks the user's global excludes, so no asset is left out of the commit.
    private static readonly string GitignoreContent =
        "*\n" +
        "!/.gitignore\n" +
        $"!/{ManifestName.Glob}\n" +
        $"!/{SourceRepositoryLayout.RootFolderName}/\n" +
        $"!/{SourceRepositoryLayout.RootFolderName}/**\n" +
        $"!/{SourceRepositoryLayout.AssetsFolderName}/\n" +
        $"!/{SourceRepositoryLayout.AssetsFolderName}/**\n";
}
