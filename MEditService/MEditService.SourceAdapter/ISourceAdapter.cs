using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>What the record index reads of tracked plugins' source trees, and the writes the commands make to them. Each
/// answers the folder as it stands now: a mod manager can replace it wholesale.</summary>
public interface ISourceAdapter
{
    bool SourceReads(RegisteredPlugin plugin);

    bool IsTracked(RegisteredPlugin plugin);

    /// <summary>True exactly when <paramref name="modFolder"/> holds a repository whose <c>main</c> exists.</summary>
    bool IsTracked(string modFolder);

    /// <summary>Why the plugin's source does not read though its mod is tracked: no folder, twin folders, or a plugin
    /// source that cannot be listed. Null when it reads, and when its mod is not tracked.</summary>
    SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin);

    /// <summary>The reads over the folder of the mod providing <paramref name="plugin"/>, tree or not; null
    /// when no mod provides it. One serves a batch, so what it learns of the tree is learned once.</summary>
    ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release);

    /// <summary>The reads over <paramref name="plugin"/>'s source tree; null when it has none that reads.</summary>
    ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release);

    /// <summary>The repository over <paramref name="provider"/>'s folder, or null when the folder is not tracked and so
    /// has no source tree to answer from.</summary>
    ISourceRepository? Open(PluginProvider.FromMod provider, GameRelease release);

    /// <summary>The repository over <paramref name="provider"/>'s folder, tracked or not. It refuses the last-written
    /// record of a plugin another mod provides (ADR-0012): a repository knows only its folder.</summary>
    ISourceRepository OverFolder(PluginProvider.FromMod provider, GameRelease release);

    /// <summary>A session over <paramref name="provider"/>'s folder, reading each of <paramref name="held"/>'s texts in
    /// place of the file at its absolute path.</summary>
    IWriteSession WriteSessionOver(PluginProvider.FromMod provider, GameRelease release, IReadOnlyList<DocumentChange> held);

    bool TreeHolds(RegisteredPlugin plugin, string path);

    RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path);

    /// <summary>The name of the file of a record's own document where no tree has renamed it.</summary>
    string FileNameOf(RecordIdentity identity);

    /// <summary>A <c>.git</c> with no <c>main</c> that Track did not mark as its own: someone else's, which Track never
    /// writes to (ADR-0003).</summary>
    bool HoldsAnotherRepository(string modFolder);

    /// <summary>Why git cannot be run here, so no repository can be made or written; null when it can.</summary>
    SourceFailure? WhyGitCannotRun();

    /// <summary>The refusal naming the instance root when it is not there; null when it is.</summary>
    string? InstanceRootNotFound(string? instanceRoot);

    /// <summary>A repository for a mod that has none: one commit, <c>Track &lt;mod&gt;</c>, on <c>main</c>, of
    /// each plugin's door tree. Answers each plugin refused, every one when no repository was made.</summary>
    IReadOnlyList<(string Plugin, string Reason)> Track(
        string modFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins);

    /// <summary><paramref name="tree"/>, the whole-mod door's, as <see cref="ISourceRepository.TreeOf"/> answers it once
    /// written: what a round-trip gate compiles, so that it compiles what is written.</summary>
    IReadOnlyList<TreeFile> ReadBackOf(string pluginFileName, IReadOnlyList<TreeFile> tree, GameRelease gameRelease);
}
