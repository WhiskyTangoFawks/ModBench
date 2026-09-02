using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>
/// The base customization every whole-mod/per-record document goes through — two settings whose
/// shape traces back to Spriggit's own "Translation Packages/Spriggit.Json.Fallout4/Customization.cs",
/// but not held to that source as
/// a specification (ADR-0042: "Spriggit has no role in v1").
///
/// <para><b>Filename numbering is deliberately off, and must stay off</b> (ADR-0042 decision 4, as
/// amended by #566). The library offers a project-wide ordering flag that prefixes every
/// folder-split sibling's file name with its list position; Modbench does not use it, because order
/// is a property of the parent's collection rather than of each child. It is carried in the parent's
/// own document instead (<c>Source.SourceChildOrder</c>), which is what makes a mid-list insert or
/// delete one file plus one line rather than a rename cascade through every later sibling. Turning
/// the flag back on would put a second, contradicting carrier in the tree, and the two would disagree
/// silently — a numbered name still deserializes perfectly well. <c>RecordOrderCustomizationBanTests</c>
/// enforces its absence across every production source, not just this one, because the flag is set
/// per generator compilation and one compilation can seed only one game: a second game means a second
/// place to set it.</para>
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
            .FilePerRecord();
    }
}
