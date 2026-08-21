using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>
/// Replicates the Spriggit-compatible customization from spike #359
/// (<c>spike/Spriggit.Spike/Customization.cs</c> on the #359 spike branch),
/// which itself mirrors Spriggit's own "Translation Packages/Spriggit.Yaml.Fallout4/Customization.cs"
/// exactly for its three base settings — the whole of that file, verified against the clone at
/// #450 rather than carried forward from the spike's replica.
///
/// <para><b>Correction (#450).</b> This comment used to list <c>.EnforceRecordOrder()</c> as
/// "present in Spriggit's real upstream file but absent from the spike's replica". That is false:
/// <c>EnforceRecordOrder</c> appears <b>nowhere</b> in <c>references/spriggit/</c> — checked across
/// the whole clone, not just the Fallout 4 package; the only thing that names it is the
/// serialization library's own source generator. There is nothing there to replicate and nothing
/// being diverged from. (It would have been a no-op here regardless: it only reaches
/// <c>SerializationHelper.WriteFilePerRecord</c>/<c>ReadFilePerRecord</c>, multi-record
/// folder-of-files group serialization, which <see cref="RecordTextCodec"/> never calls — it
/// serializes exactly one record to one caller-given file, never a group.)</para>
///
/// <para>Deliberately not replicated: <c>OmitUnknownGroupData</c>/<c>OmitUnusedConditionDataFields</c>
/// — not a choice; unavailable in Serialization 1.37.1 (spike #359 finding, Q10), and named entries
/// on #444's parity allowlist that close at the version bump.</para>
///
/// <para>What Spriggit's FO4 package adds <i>beyond</i> this base file: the five
/// <c>EmbedRecordsInSameFile</c> calls, which #450 replicates
/// (<see cref="SpriggitCellEmbedCustomization"/>); a suite of <c>SortList</c> customizations (1.38.x,
/// allowlisted); and a <c>Customizations/Omit/</c> set (<c>NextFormID</c>, <c>NumRecords</c>,
/// <c>OverriddenForms</c>, <c>Unknown1</c>) which is neither replicated nor currently allowlisted —
/// filed separately, out of scope here.</para>
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
