using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>
/// The base customization every whole-mod/per-record document goes through — three settings whose
/// shape traces back to Spriggit's own "Translation Packages/Spriggit.Json.Fallout4/Customization.cs"
/// (spike #359's replica, verified against the clone at #450), but no longer held to that source as
/// a specification (#468, ADR-0042: "Spriggit has no role in v1"). What each call does and why this
/// project still wants it is on <see cref="Customize"/>'s own inline comment below.
///
/// <para><b>Correction (#450).</b> This comment used to list <c>.EnforceRecordOrder()</c> as
/// "present in Spriggit's real upstream file but absent from the spike's replica". That is false:
/// <c>EnforceRecordOrder</c> appears <b>nowhere</b> in <c>references/spriggit/</c> — checked across
/// the whole clone, not just the Fallout 4 package; the only thing that names it is the
/// serialization library's own source generator. There is nothing there to replicate and nothing
/// being diverged from.</para>
///
/// <para><b>#459: <c>.EnforceRecordOrder()</c> is now on, and it is not a no-op.</b> The #450-era
/// claim this comment used to make ("it only reaches <c>WriteFilePerRecord</c>/<c>ReadFilePerRecord</c>,
/// which <see cref="RecordTextCodec"/> never calls") was true but incomplete: the same flag also
/// reaches <c>WriteFolderPerRecord</c>/<c>ReadFolderPerRecord</c> and <c>WriteMajorRecordList</c>/
/// <c>ReadMajorRecordList</c> — confirmed by decompiling the pinned 1.37.1
/// <c>Mutagen.Bethesda.Serialization.SourceGenerator</c> assembly directly, not by reading the newer
/// reference clone under <c>references/mutagen-serialization</c> (that clone tracks 1.38.6, a version
/// whose <c>Utility/*ParallelHelper.cs</c> refactor does not exist yet at this project's pin — its
/// <c>Utility</c> namespace at 1.37.1 has only <c>SerializationHelper</c>). All three field
/// generators that matter here (<c>GroupFieldGenerator</c>, <c>FolderPerRecordGroupFieldGenerator</c>,
/// and <c>MajorRecordListFieldGenerator</c> — the one that actually governs
/// <c>DialogTopic.Responses</c>, since that field is a plain list rather than a <c>Group&lt;T&gt;</c>)
/// read the same single project-wide <c>compilation.Customization.Overall.EnforceRecordOrder</c> bool
/// and pass it straight through as <c>withNumbering</c>. There is no per-record-type door:
/// <c>ICustomizationBuilder&lt;TObject&gt;</c> (what <see cref="SpriggitCellEmbedCustomization"/> and
/// its sibling use) exposes no <c>FilePerRecord</c>/<c>EnforceRecordOrder</c> at all. So this one call
/// on this one root builder turns on <c>"[N] "</c> filename numbering for <b>every</b> folder-split
/// relationship in the whole mod uniformly — flat top-level groups (Weapons, Npcs, …) included, not
/// only the container-nested lists the bug report's damage numbers were measured against. That
/// breadth is deliberate (ADR-0042's re-scope), not an accepted side effect — see
/// <c>Source.SourceRecordPath</c> and <c>Edits.RecordEditService</c> for what changed to keep
/// flat-record point writes (create/rename/renumber) consistent with numbered siblings now that the
/// prefix is written everywhere, not only under <c>DialogTopic.Responses</c>.</para>
///
/// <para><b>Not used, and not merely deferred</b> (#468, ADR-0042 decision 3 — "nothing is omitted
/// and nothing is re-sorted in the files, ever"): <c>OmitUnknownGroupData</c> and
/// <c>OmitUnusedConditionDataFields</c> are unavailable in this project's Serialization 1.37.1 pin
/// regardless, but even if a future bump made either available, turning it on would now be a bug,
/// not a gap to close. <b>The one tracked exception to decision 3 is the two calls right below</b> —
/// <c>OmitLastModifiedData()</c>/<c>OmitTimestampData()</c> are real, load-bearing omissions today
/// (see their own inline comment on <see cref="Customize"/>), not yet reconciled with "nothing is
/// omitted, ever"; removing them is #470's job, not this one's. Spriggit's own FO4 package layers a
/// <c>SortList</c>/<c>Customizations/Omit</c> suite on top of a base like this one; none of it is
/// adopted here for the same reason.</para>
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
            .FilePerRecord()
            .EnforceRecordOrder();
    }
}
