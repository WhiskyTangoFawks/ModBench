using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Tests;

/// <summary>A fixture's Track of one mod, through the handler over a held copy of the load order.</summary>
internal static class TrackEveryPluginOf
{
    internal static Task<SelectionResult<string, TrackRefusal, TrackedMod>> ModAsync(
        LoadOrderSnapshot loadOrder, string mod, IPluginAdapter? adapter = null, INotificationPublisher? notifications = null)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        return TestEditService.TrackHandler(holder, adapter, notifications).TrackAsync([mod]);
    }

    /// <summary>Every reason something of the selection did not track, whole mods and single plugins alike.</summary>
    internal static List<string> RefusalMessages(this SelectionResult<string, TrackRefusal, TrackedMod> result) =>
    [
        .. result.SelectionRefusal is { } refusal ? [refusal.Message] : Enumerable.Empty<string>(),
        .. result.Refused.Select(r => r.Message),
    ];

    /// <summary>The answer for a selection of one mod holding one plugin.</summary>
    internal static PluginTrack Only(this SelectionResult<string, TrackRefusal, TrackedMod> result) =>
        result switch
        {
            { SelectionRefusal: { } refusal } => new PluginTrack(false, refusal.Refusal, refusal.Message),
            { Landed: [{ Outcome: { Tracked.Count: 1 } }], Refused.Count: 0 } => new PluginTrack(true, TrackRefusal.None, ""),
            { Landed.Count: 0, Refused: [var refused] } => new PluginTrack(false, refused.Refusal, refused.Message),
            _ => throw new InvalidOperationException(
                $"Expected one plugin's answer, got {result.Landed.Count} landed and {result.Refused.Count} refused."),
        };
}

internal sealed record PluginTrack(bool Applied, TrackRefusal Refusal, string Message);
