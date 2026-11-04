using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>What the record index reads of compiled plugins' source trees, and the writes the commands make to them. Each
/// answers the folder as it stands now: another tool can change it.</summary>
public interface ISourceAdapter
{
    bool SourceReads(RegisteredPlugin plugin);

    bool IsSourceMod(RegisteredPlugin plugin);

    /// <summary>True exactly when <paramref name="sourceFolder"/> is a source mod's: it holds the build file, and a
    /// repository of its own whose <c>main</c> exists, or none, in a repository whose index holds the build file.</summary>
    bool IsSourceMod(string sourceFolder);

    /// <summary>Why the plugin's source does not read though its mod is a source mod: no folder, twin folders, or an unlistable plugin
    /// source. Null when it reads, and when its mod is not a source mod.</summary>
    SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin);

    /// <summary>The reads over the source folder of the mod providing <paramref name="plugin"/>, tree or not; null
    /// when no source mod provides it. One serves a batch, so what it learns of the tree is learned once.</summary>
    ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release);

    /// <summary>The reads over <paramref name="plugin"/>'s source tree; null when it has none that reads.</summary>
    ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release);

    /// <summary>The repository over <paramref name="provider"/>'s source folder, or null when the folder is not a source mod and so
    /// has no source tree to answer from.</summary>
    ISourceRepository? Open(PluginProvider.FromMod provider, GameRelease release);

    /// <summary>The repository over <paramref name="provider"/>'s source folder, source mod or not. It refuses the last-written
    /// record of a plugin another mod provides (ADR-0012): a repository knows only its folder.</summary>
    ISourceRepository OverFolder(PluginProvider.FromMod provider, GameRelease release);

    /// <summary>A session over <paramref name="provider"/>'s source folder, reading each of <paramref name="held"/>'s texts in
    /// place of the file at its absolute path.</summary>
    IWriteSession WriteSessionOver(PluginProvider.FromMod provider, GameRelease release, IReadOnlyList<DocumentChange> held);

    bool TreeHolds(RegisteredPlugin plugin, string path);

    RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path);

    /// <summary>The name of the file of a record's own document where no tree has renamed it.</summary>
    string FileNameOf(RecordIdentity identity);

    /// <summary>A <c>.git</c> with no <c>main</c> that init did not mark as its own: someone else's, which init never
    /// writes to (ADR-0003).</summary>
    bool HoldsAnotherRepository(string sourceFolder);

    /// <summary>Why git cannot be run here, so no repository can be made or written; null when it can.</summary>
    SourceFailure? WhyGitCannotRun();

    /// <summary>The stamp of one document's text, as the UTF-8 the record index stores: every side hashes through here, so a
    /// file that is not valid UTF-8 stamps alike on disk and in the record index.</summary>
    string ContentStamp(string text);

    /// <summary>A source folder in the repository <paramref name="heldIn"/> names, and the mod folder's manifest: one commit,
    /// <c>Init &lt;mod&gt;</c>, of the source folder, and in the instance repository that manifest, then any repair.</summary>
    SourceFailure? Init(
        string sourceFolder, byte[] buildFile, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins,
        IReadOnlyList<FileToCopy> assets, bool commit, (PluginAddress Plugin, TreeCommit Commit)? repair, RootFile? manifest, IReadOnlyList<string> ignored,
        SourceModIn heldIn, (string Folder, RootFile Manifest)? modFolderManifest);

    /// <summary>Where <paramref name="sourceFolder"/> holds the file at its forward-slash <paramref name="path"/>.</summary>
    string FileIn(string sourceFolder, string path);

    /// <summary>What a build step reads of <paramref name="read"/>, each a file or a folder in <paramref name="sourceFolder"/>,
    /// as its working tree says now.</summary>
    Answer<SourceToBuild, SourceFailure> SourceToBuild(string sourceFolder, IReadOnlyList<string> read);

    /// <summary>The commit at HEAD of <paramref name="submodule"/>. git first checks out an empty folder at the pin, on its
    /// branch when that branch is at the pin; a failed or cancelled clone leaves the folder empty.</summary>
    Answer<SubmoduleHead, SourceFailure> CommitAtHead(Submodule submodule, CancellationToken cancel);

    /// <summary><paramref name="tree"/>, the whole-mod door's, as <see cref="ISourceRepository.TreeOf"/> answers it once
    /// written: what a round-trip gate compiles, so that it compiles what is written.</summary>
    IReadOnlyList<TreeFile> ReadBackOf(string pluginFileName, IReadOnlyList<TreeFile> tree, GameRelease gameRelease);
}
