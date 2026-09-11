using MEditService.Core.Commands;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;

namespace MEditService.Tests;

/// <summary>Track over what an Index holds, as the plugin endpoint calls it: the load order from the
/// kernel's holder, and the copies the Index actually opened as the held set.</summary>
internal static class TrackHeldCopies
{
    internal static Task<TrackResult> TrackAsync(
        this TrackService track, IndexProjector index, LoadOrderHolder holder, string origin, SourcePreset preset,
        TreeDeserializer? deserializeForVerification = null) =>
        track.TrackAsync(
            holder.Current, [.. index.RequireReads().OpenedCopies.Keys], origin, preset,
            deserializeForVerification);
}
