namespace MEditService.Commands;

/// <summary>Why Put load order refused (ADR-0019).</summary>
public enum PutLoadOrderRefusal
{
    /// <summary>The Data folder the snapshot names is not on disk.</summary>
    DataFolderNotFound,

    /// <summary>A release this build has no Mutagen assembly for.</summary>
    UnsupportedGameRelease,

    /// <summary>Plugins and active plugins that make no load order (LoadOrderSnapshot.RefusalOf).</summary>
    InvalidSnapshot,
}

/// <summary>The version of the load order Put load order applied.</summary>
public sealed record PutLoadOrderApplied(long Version);

/// <summary>Why Put load order applied nothing. The message names the way out, since a
/// refusal the user cannot act on is dead UI.</summary>
public sealed record PutLoadOrderRefused(PutLoadOrderRefusal Refusal, string Message);
