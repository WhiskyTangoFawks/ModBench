using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>
/// Replicates the Spriggit-compatible customization from spike #359
/// (<c>spike/Spriggit.Spike/Customization.cs</c> on branch <c>spike-359-git-native-pending-changes</c>),
/// which itself mirrors Spriggit's own "Translation Packages/Spriggit.Yaml.Fallout4/Customization.cs"
/// exactly for its three base settings. ADR-0040 calls for replicating this ~10-line base
/// customization, not Spriggit's full production customization suite (its
/// <c>Customizations/Omit/*</c> and <c>Customizations/Sorting/*</c> per-record-type files are out of
/// scope here).
///
/// Deliberately not replicated:
/// - <c>.EnforceRecordOrder()</c> — present in Spriggit's real upstream file but absent from the
///   spike's replica; following the spike, not upstream, per #367's plan. It would be a no-op for
///   this codec regardless: it only affects <c>SerializationHelper.WriteFilePerRecord</c>/
///   <c>ReadFilePerRecord</c> (multi-record, folder-of-files group serialization),
///   a code path <see cref="RecordTextCodec"/> never calls — it serializes exactly one record to
///   one caller-given file, never a group.
/// - <c>OmitUnknownGroupData</c>/<c>OmitUnusedConditionDataFields</c> — not a choice; unavailable
///   in Serialization 1.37.1 (spike #359 finding, Q10).
/// </summary>
public sealed class RecordTextCodecCustomization : ICustomize
{
    // OmitLastModifiedData/OmitTimestampData are verified no-ops at this scope, not assumed: a
    // Weapon built with a deliberately non-default VersionControl round-trips it unchanged
    // (RecordTextCodecTests.SerializeAsync_ThenDeserializeAsync_IsFieldFaithful has no exclusion
    // list), and the serialized YAML is byte-identical with and without these two calls (checked
    // directly during #367's implementation, not inferred from the field-fidelity result alone).
    // They are mod/header-level customizations (Spriggit's own scope) with nothing on a standalone
    // Weapon to act on. Keep them anyway: ADR-0040 says replicate the customization, and they
    // become load-bearing the moment a header record (CONTEXT.md's "Header record" —
    // Fallout4ModHeader modeled as a first-class record) is ever serialized through this codec.
    // Do not read "verified no-op" as "safe to delete".
    public void Customize(ICustomizationBuilder builder)
    {
        builder
            .OmitLastModifiedData()
            .OmitTimestampData()
            .FilePerRecord();
    }
}
