using MEditService.Commands;
using MEditService.LoadOrder;
using MEditService.Index;
using MEditService.SourceRepo;

namespace MEditService.Tests;

/// <summary>Track over what an Index holds, as the plugin endpoint calls it: the load order from the
/// kernel's holder, and the copies the Index actually opened as the held set.</summary>
internal static class TrackHeldCopies
{
    internal static Task<TrackResult> TrackAsync(
        this TrackService track, IQueryIndex index, LoadOrderHolder holder, string origin, SourcePreset preset) =>
        track.TrackAsync(holder.Current, [.. index.RequireReads().OpenedCopies.Keys], origin, preset);
}
