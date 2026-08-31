using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>
/// The base customization every whole-mod/per-record document goes through — two settings whose
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
/// <c>ICustomizationBuilder&lt;TObject&gt;</c> (what <see cref="CellEmbedCustomization"/> and
/// its sibling use) exposes no <c>FilePerRecord</c>/<c>EnforceRecordOrder</c> at all. So this one call
/// on this one root builder turns on <c>"[N] "</c> filename numbering for <b>every</b> folder-split
/// relationship in the whole mod uniformly — flat top-level groups (Weapons, Npcs, …) included, not
/// only the container-nested lists the bug report's damage numbers were measured against. That
/// breadth is deliberate (ADR-0042's re-scope), not an accepted side effect — see
/// <c>Source.SourceRecordPath</c> and <c>Edits.RecordEditService</c> for what changed to keep
/// flat-record point writes (create/rename/renumber) consistent with numbered siblings now that the
/// prefix is written everywhere, not only under <c>DialogTopic.Responses</c>.</para>
///
/// <para><b>No <c>Omit*</c> call remains, and decision 3 now has no exception</b> (#468/#470,
/// ADR-0042 decision 3 — "nothing is omitted and nothing is re-sorted in the files, ever". Decision
/// 3's own text never carried an escape clause — checked across all three commits of
/// <c>docs/adr/0042-*.md</c> (<c>41542e7</c>, <c>43b4aa1</c>, <c>771cc5e</c>), the ADR document
/// itself was never amended on this point. The escape clause lived only in issue #470's own
/// original triage-draft body ("if a header counter... breaks byte identity, that is the gate
/// proving it derived — omit it and say so"), and it is the maintainer's amendment to <i>that
/// ticket</i> — a comment on #470, not a revision to the ADR — that struck it, so there is no
/// circumstance under which this class may reintroduce one).
/// <c>OmitUnknownGroupData</c> and <c>OmitUnusedConditionDataFields</c> were never available in this
/// project's Serialization 1.37.1 pin, and turning either on if a future bump ever made it available
/// would be a bug, not a gap to close. <c>OmitLastModifiedData()</c>/<c>OmitTimestampData()</c> — the
/// two calls this comment used to carry as "the one tracked exception to decision 3" — are gone as of
/// #470: <c>Fallout4Group.LastModified</c> and <c>Cell.{Persistent,Temporary}Timestamp</c>/
/// <c>Worldspace.SubCellsTimestamp</c> are ordinary fields in the source now, proven present on real
/// and hand-built records by <c>CompileRoundTripGateTests</c> and
/// <c>DocumentShapeParityTests.Serialize_OfASyntheticModWithNonDefaultGroupAndHeaderFields_WritesThemUnomitted</c>
/// respectively — removing them changed neither the committed fixture's compile round-trip
/// byte-identity nor its source-ingest parity (both re-run and green after the removal). Spriggit's
/// own FO4 package layers a <c>SortList</c>/<c>Customizations/Omit</c> suite on top of a base like
/// this one; none of it is adopted here, and none ever will be — omission and sorting are view-layer
/// concerns now, never the files (#470 amendment).</para>
/// </summary>
public sealed class RecordTextCodecCustomization : ICustomize
{
    // #470: OmitLastModifiedData()/OmitTimestampData() are gone, not merely never turned on. They
    // used to suppress Fallout4Group.LastModified (OmitLastModifiedData) and any object's
    // Timestamp/PersistentTimestamp/TemporaryTimestamp/SubCellsTimestamp fields (OmitTimestampData,
    // via CustomizationDriver.WrapOmission) — three of those ARE major-record properties
    // (Cell.PersistentTimestamp, Cell.TemporaryTimestamp, Worldspace.SubCellsTimestamp), not
    // mod/header-level, and the fourth is a plugin-file group header field, not the mod header
    // (Fallout4ModHeader) either. Both were real, load-bearing omissions (confirmed no-op only for
    // Weapon, which has none of these fields to touch) up to and including #459; removing them is
    // what closes ADR-0042 decision 3's one remaining exception, per the #470 amendment ("nothing is
    // omitted from the files under any circumstance — there is no 'gate proves it derived'
    // exception"). Do not read "no-op on Weapon" as "safe to have kept omitting" — it never was, for
    // any record with a group, a Cell, or a Worldspace in play.
    public void Customize(ICustomizationBuilder builder)
    {
        builder
            .FilePerRecord()
            .EnforceRecordOrder();
    }
}
