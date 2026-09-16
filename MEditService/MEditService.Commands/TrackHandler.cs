using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceRepo;

namespace MEditService.Commands;

/// <summary>The Track gesture's handler (ADR-0014 invariant 3). Parsing, serializing, the round-trip
/// gate, the commit and its own progress notifications stay on <see cref="TrackService"/>.</summary>
public sealed class TrackHandler
{
    private readonly TrackService _trackService;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal TrackHandler(TrackService trackService) => _trackService = trackService;

    public Task<TrackResult> TrackAsync(
        LoadOrderSnapshot loadOrder, IReadOnlyCollection<PluginCopyKey> heldCopies, string origin, SourcePreset preset,
        CancellationToken cancel = default) =>
        _trackService.TrackAsync(loadOrder, heldCopies, origin, preset, cancel);
}
