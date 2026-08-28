namespace MEditService.Core.Edits;

/// <summary>
/// Why an edit was refused — typed, never a string a caller would have to match on (ADR-0026). The
/// UI and the HTTP API both branch on this: two of these values are the untracked signposting AC4
/// pins, and each names a different way out, so collapsing them into one "read-only" would lose the
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

    /// <summary>No field of that name on this record type — or (#532) the schema names one (a
    /// #263 sibling-merge column, e.g. GLOB's <c>output_char</c>, declared only on one of several
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

    /// <summary>#417 exit path 3: the plugin's binary changed outside Modbench and the one dialog
    /// (Absorb Upstream Update / Keep as My Edit) has not been answered yet. Refused rather than
    /// silently served, per-plugin, until answered — the way out is answering the pending question,
    /// not a command.</summary>
    ExternalChangePending,

    /// <summary>#427 create: no schema table of that name (or it names the header, which is not a
    /// major record and cannot be created this way).</summary>
    RecordTypeNotFound,

    /// <summary>#427 create/renumber: the target FormKey is already held by a record at either ref —
    /// checked server-side even for an allocator-suggested value, since a caller can also supply its
    /// own (xEdit's typed-FormID path).</summary>
    FormKeyCollision,

    /// <summary>#427 renumber: at least one plugin holding a reference to the record being renumbered
    /// is not tracked, so the cascade that would rewrite its FormLink cannot land as a working-tree
    /// change there. Refused before anything is written, naming every untracked referencer.</summary>
    UntrackedReferencer,

    /// <summary>#427: one FormKey, not native to the plugin being edited, in either of two shapes —
    /// renumber's *source* is an override (its FormKey's ModKey is not the plugin being edited, so
    /// renumbering it would mean renumbering the record it overrides, across every plugin in the
    /// stack — a different and bigger operation than this gesture does), or create/renumber's
    /// caller-typed *target* FormKey belongs to a different plugin's ModKey (xEdit's own typed-FormID
    /// path never offers a foreign one either). The way out for the first is naming the originating
    /// plugin; for the second, typing a FormKey native to this plugin, or leaving it blank to
    /// auto-allocate.</summary>
    NotNativeRecord,

    /// <summary>#427 create/renumber/peek: the plugin's native FormKey space is full — every local ID
    /// up to <c>0xFFFFFF</c> is already in use at one ref or the other. A typed refusal (review
    /// finding #1), not an exception: a full plugin refusing a new record is an ordinary, expected
    /// outcome on this write path, the same doctrine as every other refusal here — never conflated
    /// with "no usable session" by a caller's generic exception handling.</summary>
    FormKeySpaceExhausted,

    /// <summary>
    /// #451 review: the record has no flat source path — a container type whose own directory holds a
    /// <c>RecordData.json</c> (Cell, Worldspace, Quest), or a record with no top-level group at all
    /// whose bytes live inside a container's document (a placed reference, a landscape, a navmesh, a
    /// dialog topic, a scene). The message used to name only the first group, which was narrower than
    /// what actually triggers it (#453 finding).
    ///
    /// <para><b>Field edits no longer refuse for this reason</b> — #453 gave them
    /// <c>SourceUnitResolver</c>. <b>#461 did the same for delete and renumber</b>: both now resolve
    /// through the same record→source-unit lookup instead of refusing outright — a container's own
    /// delete/renumber and an embedded child's are mechanical once that question has an answer. The
    /// one gesture still refused here is <see cref="CreateRecord"/> (<b>#462</b>): a brand-new record
    /// has no containment until someone chooses interior-vs-worldspace and block coordinates, which no
    /// gesture asks yet — that is a UX decision, not a mechanical one, and this refusal is what is left
    /// once delete/renumber stopped needing it.</para>
    /// </summary>
    ContainerRecordNotYetSupported,

    /// <summary>
    /// #453: nothing on disk holds this record, and the index names no container that would. Distinct
    /// from <see cref="RecordNotFound"/>, which is about the index alone: this is the index and the
    /// working tree disagreeing, i.e. the never-assume-exclusive-ownership case — a file another tool
    /// moved or removed since the session loaded. Refused rather than recreated at a computed path,
    /// because for a container there is no path to compute: its directory nesting lives in the tree,
    /// and inventing one would put the record somewhere the tree does not say it belongs.
    /// </summary>
    SourceUnitNotFound,

    /// <summary>
    /// #503: the field exists and is writable, but the value's JSON shape is not the one it takes — an
    /// array field given something that is not an array, or a struct field given something that is not
    /// an object. Always a caller bug rather than a data question, and its own refusal because the
    /// alternative is what #503 was: the applier returning without writing while the write path
    /// reported success, so a per-element payload for a complex field (CONTEXT.md: always written as
    /// one atomic value, never per-element) lost the user's edit with no signal at all.
    ///
    /// <para>#532: reused for the scalar/FormLink half of the identical defect — a converter that
    /// threw or declined (an unrecognised enum member, a non-numeric string), a JSON <c>null</c> into
    /// a non-nullable column, or an unparseable/wrongly-shaped FormKey. Not split into its own value:
    /// unlike <see cref="ListElementTypeUnresolved"/> below (whose fix is a specific, different
    /// action — name a discriminator), every one of these cases has the same fix as #503's own —
    /// send a value this field actually accepts — which is exactly what the message this refusal
    /// already carries says.</para>
    /// </summary>
    FieldValueShapeMismatch,

    /// <summary>
    /// #501: a caller-typed target FormKey (create's or renumber's own typed-FormID path) whose local
    /// ID exceeds <c>0xFFF</c> on a plugin that is ESL-flagged (header <c>Small</c> flag, or a plain
    /// <c>.esl</c> extension — <see cref="MEditService.Core.Session.PluginFlagPredicates.IsLight"/>).
    /// The engine can only address a local FormID up to <c>0xFFF</c> from a light plugin's load-order
    /// slot; above that, the record's FormKey exists in perfectly ordinary space, so
    /// <see cref="FormKeySpaceExhausted"/> would be a lie — this is its own case because the way out is
    /// different (a FormID inside the ESL range, or un-flagging the plugin), not "nothing left".
    /// </summary>
    LightPluginFormIdOutOfRange,

    /// <summary>
    /// #531: distinct from <see cref="FieldValueShapeMismatch"/> — the value genuinely is the JSON
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
    /// #491: the record carries the Partial Form header flag (bit 14, <c>0x4000</c> — CONTEXT.md's
    /// Partial Form entry), so its own fields are read-only — the game and xEdit fall through to the
    /// previous non-partial override for them, so a value written here would never be seen. Its own
    /// value rather than <see cref="FieldReadOnly"/>: the way out is different (clear the flag, or
    /// edit a different, non-partial override) from that value's causes (masters, FormKey, the
    /// widened text columns — permanent, not state-dependent), the same distinction #531's
    /// <see cref="ListElementTypeUnresolved"/> already draws against
    /// <see cref="FieldValueShapeMismatch"/>. The record header itself stays writable — #539 is
    /// where that write path (including clearing this flag) lands; this refusal covers every field
    /// this ticket's own scope reaches, which today is every field, since no header write path exists
    /// yet to exempt.
    /// </summary>
    PartialFormFieldReadOnly,
}

/// <summary>
/// One edit's outcome. <see cref="Message"/> is user-facing prose for the refusal — it names the way
/// out, since a refusal the user cannot act on is just dead UI (AC4's "no silent dead UI").
/// <see cref="NewFormKey"/> is null for every gesture except a successful create, renumber or
/// <c>PeekNextFreeFormKey</c> (#427), which are the only ones that mint or suggest a FormKey the
/// caller did not already have.
/// </summary>
public sealed record RecordEditResult(bool Applied, RecordEditRefusal Refusal, string Message, string? NewFormKey = null)
{
    public static RecordEditResult Success() => new(true, RecordEditRefusal.None, "");

    public static RecordEditResult Success(string newFormKey) => new(true, RecordEditRefusal.None, "", newFormKey);

    public static RecordEditResult Refused(RecordEditRefusal refusal, string message) =>
        new(false, refusal, message);
}
