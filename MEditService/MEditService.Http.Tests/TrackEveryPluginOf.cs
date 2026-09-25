using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Http.Tests;

/// <summary>A fixture's Track of every plugin one origin holds, as one selection.</summary>
internal static class TrackEveryPluginOf
{
    internal static Task<TrackSelectionResult> TrackModAsync(
        this TrackService track, LoadOrderSnapshot loadOrder, string origin, SourcePreset preset) =>
        track.TrackAsync(loadOrder, [.. loadOrder.CopiesOfOrigin(origin).Select(copy => copy.Key)], preset);
}
