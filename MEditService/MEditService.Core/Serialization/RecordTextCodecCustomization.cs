using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>
/// Replicates the Spriggit-compatible customization from spike #359
/// (<c>spike/Spriggit.Spike/Customization.cs</c> on the #359 spike branch),
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
    // list), and the serialized JSON is byte-identical with and without these two calls — verified again at
    // #412's YAML-to-JSON kernel swap (temporarily dropping both calls and diffing the
    // regenerated golden weapon fixture byte-for-byte), not just carried forward on the strength
    // of the original #367 verification, which was against YAML output.
    // Weapon just has nothing they touch, not "nothing on a record" in general:
    // OmitTimestampData suppresses any object's Timestamp/PersistentTimestamp/TemporaryTimestamp/
    // SubCellsTimestamp fields (CustomizationDriver.WrapOmission) — three of those ARE major-record
    // properties (Cell.PersistentTimestamp, Cell.TemporaryTimestamp, Worldspace.SubCellsTimestamp),
    // not mod/header-level. OmitLastModifiedData targets Fallout4Group.LastModified specifically —
    // a plugin-file group header field, not the mod header (Fallout4ModHeader) either. Keep both
    // anyway: ADR-0040 says replicate the customization, and they go load-bearing the moment #370
    // serializes a Cell, a Worldspace, or anything written through a group. Do not read "verified
    // no-op on Weapon" as "safe to delete" or as "only matters for headers" — neither is true.
    public void Customize(ICustomizationBuilder builder)
    {
        builder
            .OmitLastModifiedData()
            .OmitTimestampData()
            .FilePerRecord();
    }
}
