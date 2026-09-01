using MEditService.Core.Records;

namespace MEditService.Core.Edits;

/// <summary>
/// Why an edit was refused — typed, never a string a caller would have to match on (ADR-0026). The
/// UI and the HTTP API both branch on this: two of these values are the untracked signposting,
/// and each names a different way out, so collapsing them into one "read-only" would lose the
/// only thing the message has to say.
/// </summary>
public enum RecordEditRefusal
{
    /// <summary>No refusal — the edit was applied.</summary>
    None,

    /// <summary>The plugin lives in a mod folder that has no <c>.git</c>. The way out is one
    /// command, once, for this mod: Track (ADR-0041 — the friction is deliberate).</summary>
    PluginNotTracked,

    /// <summary>The plugin has no mod folder at all — a vanilla or DLC master resolved straight from
    /// the game's Data directory, where Track does not apply. The way out is the community's own
    /// blessed path: author a patch plugin holding the override.</summary>
    PluginHasNoModFolder,

    /// <summary>The plugin holds no such record at the effective ref.</summary>
    RecordNotFound,

    /// <summary>No field of that name on this record type — or the schema names one (a
    /// sibling-merge column, e.g. GLOB's <c>output_char</c>, declared only on one of several
    /// concrete subclasses sharing the table) but this particular record's own runtime type doesn't
    /// declare the backing property. Both read the same to a caller: this record genuinely has no
    /// such field.</summary>
    FieldNotFound,

    /// <summary>The field exists but is not writable — masters (derived at compile, ADR-0038), a
    /// record's own FormKey, and the widened text columns.</summary>
    FieldReadOnly,

    /// <summary>The new value would create a Dangling or Type-Mismatched FormLink (CONTEXT.md).
    /// Always a data error, and blocked at edit time rather than reported afterwards.</summary>
    InvalidFormLink,

    /// <summary>The plugin's binary changed outside Modbench and the one dialog
    /// (Absorb Upstream Update / Keep as My Edit) has not been answered yet. Refused rather than
    /// silently served, per-plugin, until answered — the way out is answering the unanswered question,
    /// not a command.</summary>
    ExternalChangeUnanswered,

    /// <summary>Create: no schema table of that name (or it names the header, which is not a
    /// major record and cannot be created this way).</summary>
    RecordTypeNotFound,

    /// <summary>Create/renumber: the target FormKey is already held by a record at either ref —
    /// checked server-side even for an allocator-suggested value, since a caller can also supply its
    /// own (xEdit's typed-FormID path).</summary>
    FormKeyCollision,

    /// <summary>Renumber: at least one plugin holding a reference to the record being renumbered
    /// is not tracked, so the cascade that would rewrite its FormLink cannot land as a working-tree
    /// change there. Refused before anything is written, naming every untracked referencer.</summary>
    UntrackedReferencer,

    /// <summary>One FormKey, not native to the plugin being edited, in either of two shapes —
    /// renumber's *source* is an override (its FormKey's ModKey is not the plugin being edited, so
    /// renumbering it would mean renumbering the record it overrides, across every plugin in the
    /// stack — a different and bigger operation than this gesture does), or create/renumber's
    /// caller-typed *target* FormKey belongs to a different plugin's ModKey (xEdit's own typed-FormID
    /// path never offers a foreign one either). The way out for the first is naming the originating
    /// plugin; for the second, typing a FormKey native to this plugin, or leaving it blank to
    /// auto-allocate.</summary>
    NotNativeRecord,

    /// <summary>Create/renumber/peek: the plugin's native FormKey space is full — every local ID
    /// up to <c>0xFFFFFF</c> is already in use at one ref or the other. A typed refusal,
    /// not an exception: a full plugin refusing a new record is an ordinary, expected
    /// outcome on this write path, the same doctrine as every other refusal here — never conflated
    /// with "no usable load order" by a caller's generic exception handling.</summary>
    FormKeySpaceExhausted,

    /// <summary>
    /// The record has no flat source path — a container type whose own directory holds a
    /// <c>RecordData.json</c> (Cell, Worldspace, Quest), or a record with no top-level group at all
    /// whose bytes live inside a container's document (a placed reference, a landscape, a navmesh, a
    /// dialog topic, a scene).
    ///
    /// <para>Field edits, delete and renumber do not refuse for this reason — they resolve through
    /// <c>SourceUnitResolver</c>'s record→source-unit lookup, which makes a container's own
    /// delete/renumber and an embedded child's mechanical. The one gesture still refused is
    /// <see cref="CreateRecord"/>: a brand-new record has no containment until someone chooses
    /// interior-vs-worldspace and block coordinates, which no gesture asks yet — a UX decision, not
    /// a mechanical one.</para>
    /// </summary>
    ContainerRecordNotYetSupported,

    /// <summary>
    /// Nothing on disk holds this record, and the index names no container that would. Distinct
    /// from <see cref="RecordNotFound"/>, which is about the index alone: this is the index and the
    /// working tree disagreeing, i.e. the never-assume-exclusive-ownership case — a file another tool
    /// moved or removed since the last reconcile. Refused rather than recreated at a computed path,
    /// because for a container there is no path to compute: its directory nesting lives in the tree,
    /// and inventing one would put the record somewhere the tree does not say it belongs.
    /// </summary>
    SourceUnitNotFound,

    /// <summary>
    /// The field exists and is writable, but the value's JSON shape is not the one it takes — an
    /// array field given something that is not an array, or a struct field given something that is not
    /// an object. Always a caller bug rather than a data question, and its own refusal because the
    /// alternative is the applier returning without writing while the write path reports success, so
    /// a per-element payload for a complex field (CONTEXT.md: always written as one atomic value,
    /// never per-element) loses the user's edit with no signal at all.
    ///
    /// <para>Also covers the scalar/FormLink half of the identical defect — a converter that
    /// threw or declined (an unrecognised enum member, a non-numeric string), a JSON <c>null</c> into
    /// a non-nullable column, or an unparseable/wrongly-shaped FormKey. Not split into its own value:
    /// unlike <see cref="ListElementTypeUnresolved"/> below (whose fix is a specific, different
    /// action — name a discriminator), every one of these cases has the same fix —
    /// send a value this field actually accepts — which is exactly what the message this refusal
    /// already carries says.</para>
    /// </summary>
    FieldValueShapeMismatch,

    /// <summary>
    /// A caller-typed target FormKey (create's or renumber's own typed-FormID path) whose local
    /// ID exceeds <c>0xFFF</c> on a plugin that is ESL-flagged (header <c>Small</c> flag, or a plain
    /// <c>.esl</c> extension — <see cref="MEditService.Core.Plugins.PluginFlagPredicates.IsLight"/>).
    /// The engine can only address a local FormID up to <c>0xFFF</c> from a light plugin's load-order
    /// slot; above that, the record's FormKey exists in perfectly ordinary space, so
    /// <see cref="FormKeySpaceExhausted"/> would be a lie — this is its own case because the way out is
    /// different (a FormID inside the ESL range, or un-flagging the plugin), not "nothing left".
    /// </summary>
    LightPluginFormIdOutOfRange,

    /// <summary>
    /// Distinct from <see cref="FieldValueShapeMismatch"/> — the value genuinely is the JSON
    /// shape the field takes (an array field given an array), but at least one element's own concrete
    /// type is abstract (OMOD <c>properties</c>' <c>AObjectModProperty&lt;T&gt;</c> today, seven
    /// concrete leaves) and could not be determined from that element's own payload. The way out is
    /// naming the element's own type discriminator (e.g. <c>value_type</c>), not sending a differently
    /// shaped value — which is why this is not folded into <see cref="FieldValueShapeMismatch"/>: the
    /// two have different fixes, and a caller branching on the enum (ADR-0026) needs to tell them apart
    /// the same way a human reading the message can.
    /// </summary>
    ListElementTypeUnresolved,

    /// <summary>
    /// The record carries the Partial Form header flag (bit 14, <c>0x4000</c> — CONTEXT.md's
    /// Partial Form entry), so its own fields are read-only — the game and xEdit fall through to the
    /// previous non-partial override for them, so a value written here would never be seen. Its own
    /// value rather than <see cref="FieldReadOnly"/>: the way out is different (clear the flag, or
    /// edit a different, non-partial override) from that value's causes (masters, FormKey, the
    /// widened text columns — permanent, not state-dependent), the same distinction
    /// <see cref="ListElementTypeUnresolved"/> already draws against
    /// <see cref="FieldValueShapeMismatch"/>. The record header itself stays writable
    /// (<c>is_partial_form</c>, including clearing this flag).
    ///
    /// <para><b>EditorID is exempt</b>: xEdit's own <c>CanAssignInternal</c>
    /// (<c>wbImplementation.pas:9905-9914</c>) explicitly allows EDID assignment on a Partial Form
    /// record — ADR-0034 makes that binding here. EditorID is an ordinary, already-writable field
    /// (<c>RecordFieldWriter.EditorIdFieldPath</c>), outside the flag-write surface. Every other
    /// field is refused unless written through <c>is_partial_form</c>.
    /// </para>
    /// </summary>
    PartialFormFieldReadOnly,

    /// <summary>
    /// A field write reached header flag bit 14 (Partial Form, <c>0x4000</c>) through some
    /// field path other than <c>is_partial_form</c> — a generic reflected column that happens to
    /// alias the same underlying <c>MajorRecordFlagsRaw</c> int (Mutagen's own
    /// <c>&lt;Game&gt;MajorRecordFlags</c>/per-type <c>MajorFlags</c> passthrough-property
    /// convention; FO4's own instances are <c>major_flags</c> and
    /// <c>fallout4_major_record_flags</c>), on a record type where that bit carries Partial Form
    /// meaning. <c>is_partial_form</c> is meant to be the one sanctioned door onto that bit — refused,
    /// and nothing is written, rather than letting a second, uncoordinated path silently set or clear
    /// the flag as a side effect of an edit that was never about it.
    ///
    /// <para>Its own value rather than <see cref="FieldReadOnly"/> or
    /// <see cref="PartialFormFieldReadOnly"/>: the field itself is not read-only (writing it to a
    /// value that leaves bit 14 unchanged still succeeds), and the record need not already carry the
    /// flag for this to fire — the way out is the same either way, though: write
    /// <c>is_partial_form</c> instead.</para>
    /// </summary>
    PartialFormFlagIndirectWrite,

    /// <summary>
    /// Copy as Override on a placed reference (or the Cell it belongs to) whose parent
    /// chain the destination does not already carry, and the missing piece is exterior — a Worldspace's
    /// SubCells cell, or the reference's own Cell when that Cell is one. Auto-creating an exterior
    /// container needs spatial placement (worldspace block/sub-block) this write path does not compute
    /// yet, tracked separately; an interior Cell auto-creates instead rather than
    /// refusing here, since interior placement carries no gameplay meaning to compute in the first
    /// place (<see cref="RecordEditService"/>'s own <c>CreateInteriorCellParent</c> doc comment has the
    /// full argument for auto-creating it as Partial Form — a deliberate mEdit-specific choice, not
    /// xEdit parity).
    /// </summary>
    ContainerParentMissingInDestination,

    /// <summary>
    /// Copy as New Record on a type xEdit itself refuses in both its UI and its engine —
    /// CELL, WRLD (and, per xEdit's own hardcoded blacklist, LAND/NAVM/PGRD/ROAD/NAVI, none of which
    /// reach this check in mEdit's own schema: <see cref="Schema.SchemaReflector"/> surfaces no table
    /// for them at all, so a copy naming one already refuses earlier as <see cref="RecordNotFound"/>).
    /// Permanent, unlike <see cref="ContainerRecordNotYetSupported"/>'s "not yet" for Quest/DialogTopic/
    /// INFO — a fresh FormKey for one of these would leave the record
    /// duplicated with no parent group to place the copy into, which xEdit blocks for exactly that
    /// structural reason, not because the feature is unbuilt.
    /// </summary>
    CopyAsNewRecordDisallowedForType,

    /// <summary>
    /// Copy as Override into a destination plugin that loads <b>before</b> the record's origin —
    /// the result would not be an override at all but an underride (#439's operation, which carries
    /// its own semantics this gesture does not implement): the origin's copy would still win at
    /// runtime, so the "copy" would silently do nothing in game. Narrow by design (#550 AC6): only
    /// the load-order direction is checked here, nothing else of #439's scope.
    /// </summary>
    UnderrideDestination,

    /// <summary>
    /// A placed reference's own file was written, but one of the two index
    /// calls that follow it (<c>CreateWorkingTreeRecord</c> for the reference's own row,
    /// <c>ApplyWorkingTreeChanges</c> for its Cell's changed body) threw — a should-never-happen guard
    /// tripping (both calls' own preconditions are already checked before either runs), never an
    /// ordinary refusal path. Converted to a typed result rather than left to propagate as a raw
    /// exception (ADR-0026: the backend never swallows a partial outcome, and a raw exception message
    /// here would say nothing about the file that already landed) — the message names exactly what
    /// state that leaves: a working-tree file the index does not yet agree with, reviewable and
    /// revertable in the Source Control panel like any other write-path fault.
    /// </summary>
    ContainerCopyIndexUpdateFailedAfterWrite,

    /// <summary>
    /// #642: the payload names a sub-field that exists in the schema but carries no write delegate
    /// for a reason that is not a discriminator no-op. Since #643 wired nested Loqui structs into
    /// the shared struct applier, this is the genuinely unwritable residue only: nested condition
    /// data (no discriminator can ever reach it) and primitive-element nested lists (no element
    /// write path at any level — refusal is parity with their own top-level columns' FieldReadOnly).
    /// Distinct from <see cref="FieldValueShapeMismatch"/>: that refusal's message ("send a value
    /// this field accepts") would be false here — the payload's shape was never the problem, the
    /// named sub-field simply has no write door. A sub-field the payload never names is unaffected —
    /// absence is not targeting, so an edit that omits the unwritable member still applies exactly as
    /// it did before this refusal existed.
    /// </summary>
    NestedFieldReadOnly,

    /// <summary>
    /// Delete or renumber, targeting the plugin header (#661) — meaningless for both. Deleting it
    /// would leave the tracked plugin with no root <c>RecordData.json</c>, which the whole-mod door
    /// needs just to identify <c>ModKey</c>/<c>GameRelease</c>; renumbering it makes no sense either,
    /// since its FormKey is synthetic (<c>HeaderIndexer.FormKeyFor</c>'s own
    /// <c>000000:&lt;plugin&gt;</c>) rather than a real allocation in the plugin's FormID space a
    /// renumber could reassign. Distinct from <see cref="RecordTypeNotFound"/>'s own header carve-out,
    /// which is Create's — that refuses because no schema table exists to instantiate a *new* header
    /// from; this refuses an *existing* header row that these two verbs structurally cannot touch.
    ///
    /// <para>Refused before <c>SourceUnit.IsDirectoryPerRecord</c> is ever consulted, deliberately:
    /// that test is filename-only (<c>RecordData.json</c>) and cannot tell the header's own root
    /// document from a container's, so an unrefused header row reaching it would be treated as a
    /// directory-per-record delete of the plugin's own source root — not a theoretical risk, but the
    /// exact data-loss defect this refusal exists to close (found in review: an unguarded
    /// <c>DeleteRecord</c> against the header deleted the plugin's entire tracked tree).</para>
    /// </summary>
    HeaderDeleteOrRenumberNotSupported,
}

/// <summary>
/// One edit's outcome. <see cref="Message"/> is user-facing prose for the refusal — it names the way
/// out, since a refusal the user cannot act on is just dead UI.
/// <see cref="NewFormKey"/> is null for every gesture except a successful create, renumber or
/// <c>PeekNextFreeFormKey</c>, which are the only ones that mint or suggest a FormKey the
/// caller did not already have.
/// </summary>
public sealed record RecordEditResult(bool Applied, RecordEditRefusal Refusal, string Message, string? NewFormKey = null)
{
    public static RecordEditResult Success() => new(true, RecordEditRefusal.None, "");

    public static RecordEditResult Success(string newFormKey) => new(true, RecordEditRefusal.None, "", newFormKey);

    public static RecordEditResult Refused(RecordEditRefusal refusal, string message) =>
        new(false, refusal, message);
}

/// <summary>One copy in a batch (#550 AC6/Q4): which record, from where, to where, and which of the
/// two copy gestures. <see cref="RequestedFormKey"/> only means anything for a copy-as-new.</summary>
public sealed record RecordCopyRequest(
    PluginKey SourcePlugin, string FormKey, PluginKey DestinationPlugin, bool AsNewRecord,
    string? RequestedFormKey = null);

/// <summary>One batch request's own outcome, paired with the record it was for.</summary>
public sealed record BatchCopyItemOutcome(string FormKey, RecordEditResult Result);

/// <summary>
/// The batch door's outcome (#550 AC6/Q4): refuse-or-commit-all. A validation failure refuses the
/// whole batch before anything writes — <see cref="RefusedFormKey"/>/<see cref="Refusal"/> name the
/// offending request, <see cref="Results"/> is empty. On commit, <see cref="Results"/> carries one
/// entry per request actually attempted, in order; a genuinely unexpected mid-write failure stops
/// the batch there, so a partial landing is visible as a shorter list (ADR-0026's structured
/// partial-success posture — the frontend decides surfacing).
/// </summary>
public sealed record BatchCopyOutcome(
    bool Applied, string? RefusedFormKey, RecordEditResult? Refusal, IReadOnlyList<BatchCopyItemOutcome> Results);
