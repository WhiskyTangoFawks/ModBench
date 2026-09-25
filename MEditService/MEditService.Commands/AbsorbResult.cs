using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>Absorb answers per changed plugin (ADR-0019 invariant 4), beside the tracked-files
/// commit, which is no plugin's. A cause the whole answer cannot escape is
/// <see cref="AnswerRefusal"/>, and nothing was written.</summary>
public sealed class AbsorbResult
{
    private AbsorbResult(
        IReadOnlyList<PluginAddress> landed, IReadOnlyList<TrackRefused> refused, string? trackedFilesRefusal,
        TrackResult? answerRefusal) =>
        (Landed, Refused, TrackedFilesRefusal, AnswerRefusal) = (landed, refused, trackedFilesRefusal, answerRefusal);

    public static AbsorbResult PerPlugin(
        IReadOnlyList<PluginAddress> landed, IReadOnlyList<TrackRefused> refused, string? trackedFilesRefusal) =>
        new(landed, refused, trackedFilesRefusal, answerRefusal: null);

    public static AbsorbResult WholeAnswerRefused(TrackRefusal refusal, string message) =>
        new([], [], trackedFilesRefusal: null, TrackResult.Refused(refusal, message));

    public IReadOnlyList<PluginAddress> Landed { get; }

    public IReadOnlyList<TrackRefused> Refused { get; }

    /// <summary>Why the commit of the mod's changed tracked files failed, after every plugin landed;
    /// null when it landed or had nothing to commit.</summary>
    public string? TrackedFilesRefusal { get; }

    public TrackResult? AnswerRefusal { get; }

    public bool AllApplied => Refused.Count == 0 && TrackedFilesRefusal is null && AnswerRefusal is null;
}
