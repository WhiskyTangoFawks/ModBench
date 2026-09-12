using System.Text.Json.Serialization;

namespace MEditService.Core.Source;

/// <summary>A rebase attempt's outcome. <see cref="ConflictedPaths"/> is the extension's cue to open
/// each path in the native merge editor; the refusal reason is set only when refused.</summary>
public sealed record RebaseResult(RebaseOutcome Outcome, string? RefusalReason, IReadOnlyList<string> ConflictedPaths)
{
    /// <summary>Clean alone: a refusal never touched the branch, and a conflict leaves the repo
    /// mid-rebase, waiting on the user's resolution rather than replayed.</summary>
    public bool Applied => Outcome == RebaseOutcome.Clean;

    public static RebaseResult Clean() => new(RebaseOutcome.Clean, null, []);

    public static RebaseResult Refused(string reason) => new(RebaseOutcome.Refused, reason, []);

    public static RebaseResult Conflicted(IReadOnlyList<string> conflictedPaths, string? refusalReason = null) =>
        new(RebaseOutcome.Conflicted, refusalReason, conflictedPaths);
}

/// <summary>The three shapes a rebase attempt can end in — never a fourth, never a thrown exception
/// for the two expected outcomes (refusal, conflict) a caller must render, not crash on.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RebaseOutcome
{
    Clean,

    /// <summary>Refused before touching the branch — uncommitted dirt in the working tree.</summary>
    Refused,

    /// <summary>Left mid-rebase with conflict markers in the conflicted paths; continuing is how the user
    /// resumes after resolving them.</summary>
    Conflicted,
}
