using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Tests;

/// <summary>A fixture's Track of one mod.</summary>
internal static class TrackEveryPluginOf
{
    internal static Task<TrackSelectionResult> TrackModAsync(
        this TrackService track, LoadOrderSnapshot loadOrder, string mod) =>
        track.TrackAsync(loadOrder, [mod]);

    /// <summary>The answer for a selection of one plugin.</summary>
    internal static TrackResult Only(this TrackSelectionResult result) =>
        result.SelectionRefusal
        ?? result.Refused switch
        {
            [var refused] when result.Landed.Count == 0 => TrackResult.Refused(refused.Refusal, refused.Message),
            [] when result.Landed.Count == 1 => TrackResult.Success(),
            _ => throw new InvalidOperationException(
                $"Expected one plugin's answer, got {result.Landed.Count} landed and {result.Refused.Count} refused."),
        };
}
