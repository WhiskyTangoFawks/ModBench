using MEditService.SourceAdapter;

namespace MEditService.Index.Queries;

/// <summary>Why a read or a filter of the Index answered nothing (ADR-0019).</summary>
public enum IndexRefusal
{
    NoLoadOrder,
    IndexNotReady,
    FilterRejected,
    CopiesMissing,
    SourceStopped,
}

public record IndexRefused(IndexRefusal Refusal, string Message);

/// <summary>The copies no plugin gave, in the order given.</summary>
public sealed record CopiesMissing(IReadOnlyList<MissingCopy> Missing)
    : IndexRefused(IndexRefusal.CopiesMissing, $"Copies not found: {string.Join("; ", Missing.Select(m => $"{m.Copy.FormKey} in {m.Copy.Plugin.Name} ({m.Copy.Plugin.Origin})"))}.");

/// <summary>The plugin's source tree could not say what a read needed.</summary>
internal sealed record SourceStopped(SourceFailure Failure) : IndexRefused(IndexRefusal.SourceStopped, Failure.Reason);
