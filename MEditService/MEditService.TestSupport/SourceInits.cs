using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.TestSupport;

public static class SourceInits
{
    /// <summary>The init of a mod with no assets.</summary>
    public static SourceFailure? Init(
        this ISourceAdapter source, string sourceFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins) =>
        source.Init(sourceFolder, BuildFile, plugins, [], commit: true);

    /// <summary>An init that names no repair, manifest or ignored path a test does not name, in a new repository unless
    /// it names the instance repository, and writes no mod folder's manifest unless it names one.</summary>
    public static SourceFailure? Init(
        this ISourceAdapter source, string sourceFolder, byte[] buildFile, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins,
        IReadOnlyList<FileToCopy> assets, bool commit, (PluginAddress Plugin, TreeCommit Commit)? repair = null, RootFile? manifest = null,
        IReadOnlyList<string>? ignored = null, SourceModIn heldIn = SourceModIn.NewRepository, (string Folder, RootFile Manifest)? modFolderManifest = null) =>
        source.Init(sourceFolder, buildFile, plugins, assets, commit, repair, manifest, ignored ?? [], heldIn, modFolderManifest);

    /// <summary>A build file, whose text the Source adapter commits as it is given.</summary>
    public static byte[] BuildFile => "the build file"u8.ToArray();
}
