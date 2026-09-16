using System.Text.Json.Serialization;

namespace MEditService.SourceRepo;

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
