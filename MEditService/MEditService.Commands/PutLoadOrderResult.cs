namespace MEditService.Commands;

/// <summary>Why Put load order refused, typed rather than a string to match on (ADR-0019).</summary>
public enum PutLoadOrderRefusal
{
    None,

    /// <summary>A release this build has no Mutagen assembly for.</summary>
    UnsupportedGameRelease,
}

/// <summary>Put load order's outcome — applied-or-refusal, never an exception (ADR-0014 invariant
/// 4). The message names the way out, since a refusal the user cannot act on is dead UI.</summary>
public sealed record PutLoadOrderResult(bool Applied, PutLoadOrderRefusal Refusal, string Message)
{
    public static PutLoadOrderResult Success() => new(true, PutLoadOrderRefusal.None, "");

    public static PutLoadOrderResult Refused(PutLoadOrderRefusal refusal, string message) => new(false, refusal, message);
}
