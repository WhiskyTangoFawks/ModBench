using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Tests;

/// <summary>A fixture's Track of every plugin one origin holds, as one selection.</summary>
internal static class TrackEveryPluginOf
{
    internal static Task<TrackSelectionResult> TrackModAsync(
        this TrackService track, LoadOrderSnapshot loadOrder, string origin, SourcePreset preset) =>
        track.TrackAsync(loadOrder, [.. loadOrder.CopiesOfOrigin(origin).Select(copy => copy.Key)], preset);

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
