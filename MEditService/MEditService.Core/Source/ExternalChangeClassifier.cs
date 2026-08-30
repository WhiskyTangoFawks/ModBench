using System.Security.Cryptography;

namespace MEditService.Core.Source;

/// <summary>
/// #417's classification step, shared verbatim by the live watcher (<c>MEditService.Bridge</c>) and
/// the load-time hash check (fired from the reconcile path) — the reason it lives here rather
/// than in the bridge assembly is exactly that sharing: both callers need the identical decision,
/// and only one of them (the load-time check, wired from <c>MEditService.Api</c>) can never depend
/// on the bridge project without a circular reference back through this one.
///
/// <para>Reads only what git and <c>meta.ini</c> already hold — no load order, no DB, matching every
/// other class in this folder.</para>
/// </summary>
public static class ExternalChangeClassifier
{
    /// <summary>
    /// Classifies <paramref name="observedBinaryBytes"/> — the bytes now sitting on disk for
    /// <paramref name="plugin"/> in <paramref name="modFolder"/> — against what Modbench last knew.
    /// Null when there is nothing to classify against: an untracked (or destroyed) mod folder is not
    /// this dialog at all (ADR-0041's "reads as untracked" — exit path 4), so the caller's own
    /// <see cref="SourceRepository.IsTracked"/> gate is what keeps this from ever being asked about
    /// one.
    /// </summary>
    public static ExternalChangeClassification? Classify(string modFolder, string plugin, byte[] observedBinaryBytes)
    {
        if (!SourceRepository.IsTracked(modFolder)) return null;

        // A marker here means the mismatch is Modbench's own interrupted compile (#416 comment 3 /
        // #417 comment 2 on the issue: "the two prompts must never both fire for one event") — checked
        // first and unconditionally, before any hash comparison, so an interrupted batch whose
        // surviving binary hash happens to still agree with the parked ref (plausible: the write
        // landed but the batch crashed before the marker was cleared) still routes to repair, not
        // here.
        if (CompileJournal.UnfinishedBatch(modFolder) != null)
            return new ExternalChangeClassification.CrashRecovery();

        var observedSha256 = Convert.ToHexStringLower(SHA256.HashData(observedBinaryBytes));
        var parkedSha256 = SourceRepository.ParkedCompileBinarySha256(modFolder, plugin);

        // Case-insensitive: ParkCompileSnapshot writes Convert.ToHexString (uppercase); this compares
        // against a lowercase hash. A missing/orphaned parked ref (parkedSha256 null) is never treated
        // as a match — the pinned decision is to degrade to asking the dialog's question, never to
        // guess self-echo from an absent reference.
        if (parkedSha256 != null && string.Equals(observedSha256, parkedSha256, StringComparison.OrdinalIgnoreCase))
            return new ExternalChangeClassification.SelfEcho();

        var baseline = SourceRepository.LatestBaselineTrailers(modFolder, plugin);
        var newVersion = MetaIni.ReadVersion(modFolder);
        var newMetaSha256 = MetaIni.ComputeSha256(modFolder);

        // "Trailers may inform defaults, never actions" (ADR-0041 amendment): unchanged or no trailer
        // both mean MetaChanged = false, which is what selects "Keep as My Edit" as the dialog's
        // default — the two cases are deliberately not distinguished any further than that.
        var metaChanged = baseline?.MetaSha256 != null && newMetaSha256 != null
            && !string.Equals(baseline.MetaSha256, newMetaSha256, StringComparison.OrdinalIgnoreCase);

        return new ExternalChangeClassification.ExternalChange(metaChanged, baseline?.UpstreamVersion, newVersion);
    }
}

/// <summary>What <see cref="ExternalChangeClassifier.Classify"/> can answer. Never both a crash and
/// an external change for one event (#417 comment 2 on the issue) — exactly one of these three.</summary>
public abstract record ExternalChangeClassification
{
    /// <summary>The observed binary is Save &amp; Compile's own write (its hash matches the parked
    /// ref) — not an external change at all; the watcher/load-time check has nothing to do.</summary>
    public sealed record SelfEcho : ExternalChangeClassification;

    /// <summary>A journal marker is present: this mismatch is Modbench's own interrupted compile.
    /// Routes to #381's repair offer, never to #417's dialog (suppression only — #417 does not build
    /// the repair offer itself).</summary>
    public sealed record CrashRecovery : ExternalChangeClassification;

    /// <summary>A genuine external change — xEdit, a mod update, a hand edit. <see cref="MetaChanged"/>
    /// is the dialog's default-button tell; <see cref="OldVersion"/>/<see cref="NewVersion"/> are the
    /// evidence shown in the dialog's detail text when it fired.</summary>
    public sealed record ExternalChange(bool MetaChanged, string? OldVersion, string? NewVersion) : ExternalChangeClassification;

    private ExternalChangeClassification()
    {
    }
}
