using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The Track gesture's handler (ADR-0014 invariant 3). Parsing, serializing, the round-trip
/// gate, the commit and its own progress notifications stay on <see cref="TrackService"/>.</summary>
public sealed class TrackHandler
{
    private readonly TrackService _trackService;
    private readonly LoadOrderHolder _loadOrder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal TrackHandler(TrackService trackService, LoadOrderHolder loadOrder) =>
        (_trackService, _loadOrder) = (trackService, loadOrder);

    /// <summary>Each plugin names its copy, which the held load order resolves to a mod folder
    /// (ADR-0013 invariant 4). Throws <see cref="NoLoadOrderException"/> with nothing written when none
    /// is held.</summary>
    public Task<TrackSelectionResult> TrackAsync(
        IReadOnlyList<PluginCopyKey> plugins, SourcePreset preset, CancellationToken cancel = default) =>
        _trackService.TrackAsync(_loadOrder.Require(), plugins, preset, cancel);
}
