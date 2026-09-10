using MEditService.Core.Plugins;
using MEditService.Core.Source;

namespace MEditService.Core.Commands;

/// <summary>The Track gesture's handler (ADR-0046 invariant 3). Parsing, serializing, the round-trip
/// gate and the commit stay on <see cref="TrackService"/>, along with its own progress channel that
/// <c>GET /plugins/track/status</c> polls.</summary>
public sealed class TrackHandler
{
    private readonly TrackService _trackService;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal TrackHandler(TrackService trackService) => _trackService = trackService;

    public Task<TrackResult> TrackAsync(
        LoadOrder loadOrder, IReadOnlyCollection<PluginKey> heldCopies, string origin, SourcePreset preset,
        CancellationToken cancel = default) =>
        _trackService.TrackAsync(loadOrder, heldCopies, origin, preset, cancel);
}
