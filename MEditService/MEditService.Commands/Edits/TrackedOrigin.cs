using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Edits;

/// <summary>What a gesture the mod is the unit of (Absorb, Keep) acts on: the copies under the
/// origin and the tracked folder they share. Null for an origin no copy carries, or an untracked
/// folder.</summary>
internal sealed record TrackedOrigin(string ModFolder, IReadOnlyList<RegisteredCopy> Plugins)
{
    internal static TrackedOrigin? Resolve(LoadOrderSnapshot loadOrder, string origin)
    {
        var plugins = loadOrder.CopiesOfOrigin(origin);
        if (plugins.Count == 0) return null;

        var modFolder = LoadOrderSnapshot.ModFolderOf(plugins[0].Origin, plugins[0].Path);
        return modFolder is null || !SourceRepository.IsTracked(modFolder) ? null : new TrackedOrigin(modFolder, plugins);
    }
}
