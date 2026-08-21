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

    /// <summary>No field of that name on this record type.</summary>
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
    /// #451 review: the record (or, for renumber, a referencer of it) has no flat source path — a
    /// container type whose own directory holds a <c>RecordData.json</c> (Cell, Worldspace, Quest), or
    /// a record with no top-level group at all whose bytes live inside a container's document (a
    /// placed reference, a landscape, a navmesh, a dialog topic, a scene). The message used to name
    /// only the first group, which was narrower than what actually triggers it (#453 finding).
    ///
    /// <para><b>Field edits no longer refuse for this reason</b> — #453 gave them
    /// <c>SourceUnitResolver</c>. What still refuses is delete and renumber (<b>#461</b>: both are
    /// structural, changing which children a container holds rather than one child's fields) and
    /// create (<b>#462</b>: a new container has no containment until someone chooses interior-vs-
    /// worldspace and block coordinates, which no gesture asks yet).</para>
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
