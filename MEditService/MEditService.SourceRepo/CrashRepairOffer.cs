using System.Text.Json.Serialization;

namespace MEditService.SourceRepo;

/// <summary>A tracked plugin whose binary is stale or missing since Modbench last knew it. A loud
/// "rebuild it" offer, never the external-change dialog, whose "keep as mine" answer has no
/// meaning for a half-written binary.</summary>
public sealed record CrashRepairOffer(string Plugin, string Origin, CrashRepairReason Reason);

/// <summary>Both reasons are detected only at reconcile, never by the live watcher: neither can
/// newly arise while this Modbench process keeps running.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CrashRepairReason
{
    /// <summary>An unfinished <see cref="CompileJournal"/> marker: Modbench's own interrupted compile,
    /// never an external tool's doing.</summary>
    InterruptedCompile,

    /// <summary>The binary could not be read while its mod folder and repo survive — ADR-0007's
    /// "reads as untracked" case.</summary>
    MissingOrUnreadableBinary,
}
