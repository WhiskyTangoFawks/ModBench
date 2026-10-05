using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Http.Tests;

/// <summary>A fixture's Track of one mod.</summary>
internal static class TrackEveryPluginOf
{
    internal static Task<TrackSelectionResult> TrackModAsync(
        this TrackService track, LoadOrderSnapshot loadOrder, string mod) =>
        track.TrackAsync(loadOrder, [mod]);
}
