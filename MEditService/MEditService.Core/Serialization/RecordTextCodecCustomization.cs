using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>
/// Replicates the base of Spriggit's overall customization —
/// <c>references/spriggit/Translation Packages/Spriggit.Json.Fallout4/Customization.cs</c>, whose five
/// calls are <c>OmitLastModifiedData().OmitTimestampData().OmitUnknownGroupData()
/// .OmitUnusedConditionDataFields().FilePerRecord()</c>. Three of those five are reproduced below; the
/// other two are unavailable in this project's pin and are addressed in their own paragraph.
///
/// <para><b>Cite the JSON package, not the YAML one</b> (corrected #455; this comment named
/// <c>Spriggit.Yaml.Fallout4</c>, inherited from spike #359 when the kernel was still YAML). ADR-0041
/// moved the project to the JSON kernel at #412 and <c>SpriggitSource.PackageName</c> is
/// <c>Spriggit.Json.Fallout4</c>, so the JSON package is the specification we are held to. The two
/// packages' <c>Customization.cs</c> happen to be identical call-for-call, so nothing below changes —
/// but their <c>Customizations/</c> trees are <b>not</b> identical, and reading the wrong one is a real
/// trap: the YAML package carries <c>HeadDataCustomization</c> and <c>SceneCustomization</c> that the
/// JSON package does not. Anything replicated from upstream is read from the JSON package.</para>
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
/// <para>What Spriggit's FO4 package adds <i>beyond</i> this base file, and where each lands:
/// the five <c>EmbedRecordsInSameFile</c> calls, replicated at #450
/// (<see cref="SpriggitCellEmbedCustomization"/>); a suite of <c>SortList</c> customizations across
/// nine-plus record types, which is 1.38.x-only and is therefore a named row on #455's parity
/// allowlist rather than something replicable; and the <c>Customizations/Omit/</c> set
/// (<c>Condition.Unknown1</c>, <c>ModStats.NextFormID</c>, <c>ModStats.NumRecords</c>,
/// <c>Fallout4ModHeader.OverriddenForms</c>), <b>replicated at #455</b>
/// (<see cref="SpriggitConditionOmitCustomization"/> and its two siblings). Plain <c>Omit</c> exists in
/// the 1.37.1 pin, so unlike <c>SortList</c> it was adoptable now — and had to be adopted rather than
/// allowlisted, since a row that can never close would falsely suppress #444's convergence trigger.</para>
///
/// <para><b>Correction (#455).</b> The paragraph above used to say that <c>Customizations/Omit/</c> set
/// was "neither replicated nor currently allowlisted — filed separately, out of scope here." That
/// stopped being true when #455 replicated it, and is corrected here. This is the second false claim
/// found in this comment block (see the #450 correction above); it is long, it has drifted twice, and
/// the next reader should check it against the clone rather than trust it.</para>
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
