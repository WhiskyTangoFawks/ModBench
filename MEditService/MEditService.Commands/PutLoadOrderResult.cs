namespace MEditService.Commands;

/// <summary>Why Put load order refused (ADR-0019).</summary>
public enum PutLoadOrderRefusal
{
    None,

    /// <summary>A release this build has no Mutagen assembly for.</summary>
    UnsupportedGameRelease,

    /// <summary>Plugins and active plugins that make no load order (LoadOrderSnapshot.RefusalOf).</summary>
    InvalidSnapshot,
}

/// <summary>Put load order's outcome (ADR-0014). The message names the way out, since a
/// refusal the user cannot act on is dead UI.</summary>
public sealed record PutLoadOrderResult(bool Applied, PutLoadOrderRefusal Refusal, string Message, long Version = 0)
{
    internal static PutLoadOrderResult Success(long version) => new(true, PutLoadOrderRefusal.None, "", version);

    internal static PutLoadOrderResult Refused(PutLoadOrderRefusal refusal, string message) => new(false, refusal, message);
}
