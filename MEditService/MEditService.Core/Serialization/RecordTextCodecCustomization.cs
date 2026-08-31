using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>
/// The base customization every whole-mod/per-record document goes through — two settings whose
/// shape traces back to Spriggit's own "Translation Packages/Spriggit.Json.Fallout4/Customization.cs",
/// but not held to that source as
/// a specification (ADR-0042: "Spriggit has no role in v1").
///
/// <para><b><c>.EnforceRecordOrder()</c> is not a no-op.</b> Beyond
/// <c>WriteFilePerRecord</c>/<c>ReadFilePerRecord</c>
/// (which <see cref="RecordTextCodec"/> never calls), the same flag
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
/// <c>ICustomizationBuilder&lt;TObject&gt;</c> (what <see cref="CellEmbedCustomization"/> and
/// its sibling use) exposes no <c>FilePerRecord</c>/<c>EnforceRecordOrder</c> at all. So this one call
/// on this one root builder turns on <c>"[N] "</c> filename numbering for <b>every</b> folder-split
/// relationship in the whole mod uniformly — flat top-level groups (Weapons, Npcs, …) included, not
/// only the container-nested lists. That
/// breadth is deliberate (ADR-0042's re-scope), not an accepted side effect — see
/// <c>Source.SourceRecordPath</c> and <c>Edits.RecordEditService</c> for what keeps
/// flat-record point writes (create/rename/renumber) consistent with numbered siblings, given the
/// prefix is written everywhere, not only under <c>DialogTopic.Responses</c>.</para>
///
/// <para><b>No <c>Omit*</c> call exists, and decision 3 has no exception</b> (ADR-0042 decision 3 —
/// "nothing is omitted and nothing is re-sorted in the files, ever"; the decision carries no escape
/// clause, so there is no circumstance under which this class may introduce one).
/// <c>OmitUnknownGroupData</c> and <c>OmitUnusedConditionDataFields</c> were never available in this
/// project's Serialization 1.37.1 pin, and turning either on if a future bump ever made it available
/// would be a bug, not a gap to close.
/// <c>OmitLastModifiedData()</c>/<c>OmitTimestampData()</c> would suppress real, load-bearing
/// fields — <c>Fallout4Group.LastModified</c> and <c>Cell.{Persistent,Temporary}Timestamp</c>/
/// <c>Worldspace.SubCellsTimestamp</c> are ordinary fields in the source, proven present on real
/// and hand-built records by <c>CompileRoundTripGateTests</c> and
/// <c>DocumentShapeParityTests.Serialize_OfASyntheticModWithNonDefaultGroupAndHeaderFields_WritesThemUnomitted</c>
/// respectively (do not read "no-op on Weapon", which has none of these fields, as "safe to omit" —
/// it isn't, for any record with a group, a Cell, or a Worldspace in play). Spriggit's
/// own FO4 package layers a <c>SortList</c>/<c>Customizations/Omit</c> suite on top of a base like
/// this one; none of it is adopted here, and none ever will be — omission and sorting are view-layer
/// concerns, never the files.</para>
/// </summary>
public sealed class RecordTextCodecCustomization : ICustomize
{
    public void Customize(ICustomizationBuilder builder)
    {
        builder
            .FilePerRecord()
            .EnforceRecordOrder();
    }
}
