using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests;

/// <summary>Track over what an Index holds, as the plugin endpoint calls it: the load order as the
/// value, and the copies Editing actually opened as the held set.</summary>
internal static class TrackHeldCopies
{
    internal static Task<TrackResult> TrackAsync(
        this TrackService track, IndexProjector index, string origin, SourcePreset preset,
        Func<string, CancellationToken, Task<IFallout4Mod>>? deserializeForVerification = null)
    {
        var held = index.LoadOrder!;
        return track.TrackAsync(
            LoadOrder.From(held), [.. held.Plugins.Select(p => p.Key)], origin, preset,
            deserializeForVerification);
    }
}
