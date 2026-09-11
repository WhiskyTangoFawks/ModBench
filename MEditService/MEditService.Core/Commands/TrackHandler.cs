using MEditService.Core.Plugins;
using MEditService.Core.Source;

namespace MEditService.Core.Commands;

/// <summary>The Track gesture's handler (ADR-0014 invariant 3). Parsing, serializing, the round-trip
/// gate, the commit and its own progress notifications stay on <see cref="TrackService"/>.</summary>
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
