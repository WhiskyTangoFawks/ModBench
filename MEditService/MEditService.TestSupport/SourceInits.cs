using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;

namespace MEditService.TestSupport;

public static class SourceInits
{
    /// <summary>The init of a mod with no assets.</summary>
    public static SourceFailure? Init(
        this ISourceAdapter source, string sourceFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins) =>
        source.Init(sourceFolder, BuildFile, plugins, [], commit: true);

    /// <summary>A build file, whose text the Source adapter commits as it is given.</summary>
    public static byte[] BuildFile => "the build file"u8.ToArray();
}
