using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;

namespace MEditService.TestSupport;

public static class SourceInits
{
    /// <summary>The init of a mod with no assets, whose output is the test mod's folder.</summary>
    public static SourceFailure? Init(
        this ISourceAdapter source, string sourceFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins) =>
        source.Init(sourceFolder, TestMod.Name, plugins, []);
}
