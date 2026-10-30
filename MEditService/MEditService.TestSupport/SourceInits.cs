using System.Text;
using MEditService.Codec.Serialization;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.TestSupport;

public static class SourceInits
{
    /// <summary>The init of a mod with no assets, whose output is the test mod's folder.</summary>
    public static SourceFailure? Init(
        this ISourceAdapter source, string sourceFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins) =>
        source.Init(sourceFolder, ManifestOf(TestMod.Name), plugins, []);

    /// <summary>A manifest for <paramref name="output"/>, whose text the Source adapter commits as it is given.</summary>
    public static SpelledManifest ManifestOf(string output) => new($"{output}.manifest.json", Encoding.UTF8.GetBytes($"the manifest of {output}"));
}
