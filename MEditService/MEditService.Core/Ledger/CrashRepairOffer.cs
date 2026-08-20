namespace MEditService.Core.Ledger;

/// <summary>
/// #381: a tracked plugin whose binary the load-time check found stale or missing relative to what
/// Modbench itself last knew, surfaced as a loud "rebuild it" offer — never the external-change
/// dialog (#417), which asks a question ("upstream update, or your own edit?") that has no honest
/// answer here: there is no alternate "keep as mine" outcome for a binary Modbench's own compile
/// left half-written, or that no longer exists at all.
/// </summary>
public sealed record CrashRepairOffer(string Plugin, string Origin, CrashRepairReason Reason);

/// <summary>The two ways <see cref="ExternalChangeSessionHook"/> can reach a repair offer — both
/// detected only at session load (#381's spec pin: "a journal marker present at load"), never by the
/// live watcher, because neither condition can newly arise while this same Modbench process keeps
/// running: the journal only moves during a compile <see cref="Edits.PluginCompileService"/> itself
/// drives, and a binary that vanished mid-session would already have been read once at load.</summary>
public enum CrashRepairReason
{
    /// <summary>A <see cref="CompileJournal"/> marker is pending in this plugin's mod folder — the
    /// mismatch is Modbench's own interrupted compile (crash, or a kill mid-write), never an
    /// external tool's doing.</summary>
    InterruptedCompile,

    /// <summary>The plugin's binary could not be read at all — deleted, moved, or torn — while its
    /// mod folder and repo survive. Reachable without the repo being destroyed (ADR-0041's "reads as
    /// untracked" case): the user or another tool can delete just the plugin file and leave `.git`
    /// intact.</summary>
    MissingOrUnreadableBinary,
}
