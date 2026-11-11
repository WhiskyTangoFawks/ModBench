using MEditService.RepositoriesLib;
using Mutagen.Bethesda;

namespace MEditService.PluginAdapter;

public static class PluginOriginalHashes
{
    /// <summary>The hash of the file with each named flag at each combination of its possible original values, nothing
    /// written; none when a named flag is not as <paramref name="flags"/> sets it.</summary>
    public static Answer<IReadOnlyList<string>, PluginFailure> Of(string path, IReadOnlyDictionary<string, bool> flags, GameRelease gameRelease) =>
        PluginFailure.Answer<IReadOnlyList<string>>(() => PluginLoadFlags.OriginalHashes(path, flags, gameRelease));
}
