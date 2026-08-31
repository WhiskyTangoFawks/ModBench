using MEditService.Core.Source;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>
/// Record-header flag bit 14 (<c>0x4000</c>) — "Partial Form" (CONTEXT.md's own glossary
/// entry). An override carrying this flag exists only to carry children; its own fields are ignored
/// for conflict resolution (<see cref="MEditService.Core.Queries.ConflictClassifier"/>) and it is
/// read-only except its header.
///
/// <para><b>The bit alone is not enough — and neither, it turns out, is Mutagen's own type-eligibility
/// metadata.</b> Bit 14 is reused for unrelated meanings on record types that never declare a
/// <c>'Partial Form'</c> header flag at all — reading it unconditionally would silently misclassify
/// an ordinary record whose own flags happen to set that bit. xEdit itself gates on the record
/// definition declaring the flag (<c>mrDef.CanBePartial</c>, <c>wbInterface.pas:10982-10993</c>).
/// Mutagen's generator exposes the same fact as a static <c>IsPartialFormable</c> property, but not
/// reliably: it lives on the Loqui *registration* class (e.g. <c>Quest_Registration</c>), reached via
/// the record type's own <c>StaticRegistration</c> property — and, checked against the pinned
/// Mutagen build, is only wired up for FO4's <c>Quest</c>/<c>Location</c> and Starfield's
/// <c>Cell</c>/<c>Quest</c>/<c>DialogTopic</c>. FO4's own <c>Cell</c> does not carry it — which would
/// silently mask exactly the record type CONTEXT.md's glossary names and the motivating real-world
/// case (Sim Settlements 2's Partial Form Cell overrides), an upstream Mutagen gap rather
/// than a fact about the format.</para>
///
/// <para><b>So this gates on being a container record instead</b> —
/// <see cref="ContainerChildFields.EnumerateChildFieldsFor"/>, this codebase's own hand-maintained,
/// exhaustively swept (<c>ContainerChildFieldsCompletenessTests</c>) table of exactly Cell/
/// Worldspace/Quest/DialogTopic, keyed by CLR type name so the same table serves every game's own
/// assembly without a per-game list. That set is not a coincidence: Partial Form exists specifically
/// so a container can carry children without asserting its own fields, so "does this type have
/// children to carry" is the domain-correct gate, not merely a workaround for Mutagen's own coverage
/// gap — CELL/WRLD/DIAL/QUST are exactly ContainerChildFields' four keys.</para>
/// </summary>
public static class PartialFormFlag
{
    /// <summary>Internal rather than private: <see cref="MEditService.Core.Edits.RecordEditService"/>'s
    /// own bit-14 write-surface guard needs the literal bit value to compare a field write's
    /// before/after <c>MajorRecordFlagsRaw</c> — reading it off here rather than re-declaring
    /// <c>0x4000</c> a second time keeps the one fact in the one place that already owns it.</summary>
    internal const int Bit = 0x0000_4000;

    /// <summary>Whether <paramref name="recordType"/> is a container record — the only kind that can
    /// carry a Partial Form override at all. Split out of <see cref="IsSet"/> so the write path
    /// can ask "is this type eligible" on its own, independent of whether the bit happens to be set
    /// right now — setting the flag needs the same gate <see cref="IsSet"/> uses for reading it:
    /// this is the one gate, not a second reflection-based one.</summary>
    internal static bool IsPartialFormable(Type recordType) =>
        ContainerChildFields.EnumerateChildFieldsFor(recordType) != null;

    /// <summary>True when <paramref name="record"/>'s own concrete type is a container record (the
    /// only kind that can carry a Partial Form override at all) and its header flags have the bit
    /// set.</summary>
    public static bool IsSet(IMajorRecordGetter record) =>
        IsPartialFormable(record.GetType()) && (record.MajorRecordFlagsRaw & Bit) != 0;

    /// <summary>
    /// The one sanctioned bit-14 write — sets or clears exactly this bit against
    /// <paramref name="record"/>'s <em>current</em> <c>MajorRecordFlagsRaw</c>, never a full
    /// overwrite. A full overwrite (<c>MajorRecordFlagsRaw = value ? Bit : 0</c>) would silently drop
    /// every other flag bit already set on the record (ESM, Deleted, …) — only bit 14 may move.
    /// Callers (<see cref="MEditService.Core.Edits.RecordFieldWriter"/>) are expected to have already
    /// checked <see cref="IsPartialFormable"/> — this does not re-check it, since a caller reaching
    /// here has already decided the record type is eligible.
    /// </summary>
    internal static void Set(IMajorRecord record, bool value) =>
        record.MajorRecordFlagsRaw = value
            ? record.MajorRecordFlagsRaw | Bit
            : record.MajorRecordFlagsRaw & ~Bit;
}
