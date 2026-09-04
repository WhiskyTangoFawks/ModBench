using System.Security.Cryptography;

namespace MEditService.Core.Source;

/// <summary>The external-change classification step, shared by the live watcher (<c>MEditService.Bridge</c>)
/// and the load-time hash check: both need the identical decision, and the load-time check cannot
/// depend on the bridge assembly.</summary>
public static class ExternalChangeClassifier
{
    /// <summary>Null when there is nothing to classify against: an untracked or destroyed mod folder is
    /// not this dialog at all (ADR-0041's "reads as untracked" exit path).</summary>
    public static ExternalChangeClassification? Classify(string modFolder, string plugin, byte[] observedBinaryBytes)
    {
        if (!SourceRepository.IsTracked(modFolder)) return null;

        // A marker means Modbench's own interrupted compile. Checked first and unconditionally so the
        // repair and external-change prompts never both fire: a surviving binary whose hash still matches
        // the parked ref must route to repair.
        if (CompileJournal.UnfinishedBatch(modFolder) != null)
            return new ExternalChangeClassification.CrashRecovery();

        var observedSha256 = Convert.ToHexStringLower(SHA256.HashData(observedBinaryBytes));
        var parkedSha256 = SourceRepository.ParkedCompileBinarySha256(modFolder, plugin);

        // Case-insensitive: ParkCompileSnapshot writes uppercase hex. A missing parked ref is never a
        // match — degrade to asking the dialog's question, never guess self-echo from an absent reference.
        if (parkedSha256 != null && string.Equals(observedSha256, parkedSha256, StringComparison.OrdinalIgnoreCase))
            return new ExternalChangeClassification.SelfEcho();

        var baseline = SourceRepository.LatestBaselineTrailers(modFolder, plugin);
        var newVersion = MetaIni.ReadVersion(modFolder);
        var newMetaSha256 = MetaIni.ComputeSha256(modFolder);

        // "Trailers may inform defaults, never actions" (ADR-0041 amendment): unchanged or absent both mean
        // MetaChanged = false, which selects "Keep as My Edit" as the default.
        var metaChanged = baseline?.MetaSha256 != null && newMetaSha256 != null
            && !string.Equals(baseline.MetaSha256, newMetaSha256, StringComparison.OrdinalIgnoreCase);

        return new ExternalChangeClassification.ExternalChange(metaChanged, baseline?.UpstreamVersion, newVersion);
    }
}

/// <summary>What <see cref="ExternalChangeClassifier.Classify"/> can answer. Never both a crash and
/// an external change for one event — exactly one of these three.</summary>
public abstract record ExternalChangeClassification
{
    /// <summary>The observed binary is Save &amp; Compile's own write (its hash matches the parked
    /// ref) — not an external change at all; the watcher/load-time check has nothing to do.</summary>
    public sealed record SelfEcho : ExternalChangeClassification;

    /// <summary>A journal marker is present: this mismatch is Modbench's own interrupted compile.
    /// Routes to the repair offer, never to the external-change dialog (suppression only — the
    /// classifier does not build the repair offer itself).</summary>
    public sealed record CrashRecovery : ExternalChangeClassification;

    /// <summary>A genuine external change — xEdit, a mod update, a hand edit. <see cref="MetaChanged"/>
    /// is the dialog's default-button tell; the versions are the evidence shown in its detail text.</summary>
    public sealed record ExternalChange(bool MetaChanged, string? OldVersion, string? NewVersion) : ExternalChangeClassification;

    private ExternalChangeClassification()
    {
    }
}
