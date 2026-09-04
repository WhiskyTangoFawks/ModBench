using MEditService.Core.Records;

namespace MEditService.Core.Edits;

/// <summary>Why an edit was refused, typed rather than a string to match on (ADR-0026). Each value
/// names a different way out, which is what the message has to say.</summary>
public enum RecordEditRefusal
{
    None,

    /// <summary>The way out is Track, once per mod (ADR-0041: the friction is deliberate).</summary>
    PluginNotTracked,

    /// <summary>A vanilla/DLC master straight from Data, where Track cannot apply; the way out is a patch plugin.</summary>
    PluginHasNoModFolder,

    RecordNotFound,

    /// <summary>Also a schema column this record's own runtime subclass lacks (a sibling-merge column).</summary>
    FieldNotFound,

    /// <summary>Permanently unwritable (masters are compile-derived, ADR-0038), unlike the state-dependent Partial Form refusal.</summary>
    FieldReadOnly,

    /// <summary>Blocked at edit time rather than reported afterwards: always a data error.</summary>
    InvalidFormLink,

    /// <summary>Refused per plugin until the Absorb/Keep dialog is answered; the way out is answering it.</summary>
    ExternalChangeUnanswered,

    /// <summary>Create: no schema table of that name, or the header, which cannot be created this way.</summary>
    RecordTypeNotFound,

    /// <summary>Held at either ref; checked server-side even for an allocator-suggested value, since a caller can type its own.</summary>
    FormKeyCollision,

    /// <summary>Renumber: a referencer's FormLink rewrite cannot land as a working-tree change in an untracked plugin. Refused before any write.</summary>
    UntrackedReferencer,

    /// <summary>Renumbering an override would mean renumbering it across every plugin in the stack; a typed target must be native for the same reason.</summary>
    NotNativeRecord,

    /// <summary>Mutagen's generated <c>RemapLinks</c> skips <c>ScriptStructListProperty.Structs</c>
    /// (upstream-mutagen-issue.md), so a VMAD struct-list link survives the remap; refused rather than written half-remapped.</summary>
    ReferenceRemapIncomplete,

    /// <summary>A typed refusal, not an exception: a full plugin is an ordinary outcome, never conflated with "no usable load order".</summary>
    FormKeySpaceExhausted,

    /// <summary>No flat source path: a container's own directory, or a child embedded in one. A new
    /// record has no containment until a gesture asks for it, which is a UX decision.</summary>
    ContainerRecordNotYetSupported,

    /// <summary>The index and the working tree disagree (a file moved outside Modbench). Not recreated at
    /// a computed path: a container's path lives in the tree, not in a formula.</summary>
    SourceUnitNotFound,

    /// <summary>Its own refusal because the alternative is the applier returning without writing while
    /// the edit reports success. Every case here has the same fix: send a value the field accepts.</summary>
    FieldValueShapeMismatch,

    /// <summary>A light plugin's slot addresses local IDs only up to 0xFFF; native space is not exhausted,
    /// so the way out differs from <see cref="FormKeySpaceExhausted"/>.</summary>
    LightPluginFormIdOutOfRange,

    /// <summary>The way out is naming the element's type discriminator, not a differently shaped value,
    /// so a caller branching on the enum (ADR-0026) can tell it from <see cref="FieldValueShapeMismatch"/>.</summary>
    ListElementTypeUnresolved,

    /// <summary>A Partial Form record's own fields are never seen by the game; the way out is clearing the
    /// flag. EditorID is exempt: xEdit's <c>CanAssignInternal</c> allows EDID on a Partial Form (ADR-0034).</summary>
    PartialFormFieldReadOnly,

    /// <summary>Header flag bit 14 reached through a reflected column aliasing <c>MajorRecordFlagsRaw</c>;
    /// <c>is_partial_form</c> is the one sanctioned door onto that bit, so nothing is written.</summary>
    PartialFormFlagIndirectWrite,

    /// <summary>The missing ancestor is exterior with no spatial placement to mint from (a TopCell, or no
    /// parent worldspace); an interior Cell auto-creates instead, since its placement carries no meaning.</summary>
    ContainerParentMissingInDestination,

    /// <summary>Permanent, matching xEdit: a fresh FormKey for CELL/WRLD leaves the copy with no parent group to sit in.</summary>
    CopyAsNewRecordDisallowedForType,

    /// <summary>A destination loading before the origin would be an underride (#439's own operation): the
    /// origin's copy would still win at runtime.</summary>
    UnderrideDestination,

    /// <summary>The reference's file already landed when an index call threw (a should-never-happen guard).
    /// Typed rather than a raw exception (ADR-0026) so the message names the reviewable working-tree file.</summary>
    ContainerCopyIndexUpdateFailedAfterWrite,

    /// <summary>The payload names a sub-field with no write delegate; the shape was never the problem, so
    /// <see cref="FieldValueShapeMismatch"/>'s message would be false.</summary>
    NestedFieldReadOnly,

    /// <summary>Entries in a keyed array are identified by key, not position, so a second one is a
    /// collision; the message names the key.</summary>
    DuplicateKeyInKeyedArray,

    /// <summary>Deleting the header would remove the root <c>RecordData.json</c> the whole-mod door needs;
    /// its FormKey is synthetic. Refused before <c>SourceUnit.IsDirectoryPerRecord</c>, whose filename-only
    /// test would delete the whole source root.</summary>
    HeaderDeleteOrRenumberNotSupported,
}

/// <summary><see cref="Message"/> names the way out; a refusal the user cannot act on is dead UI.
/// <c>EslContradiction</c> marks a FormKeySpaceExhausted caused only by the removable ESL flag, so
/// the frontend can prompt.</summary>
public sealed record RecordEditResult(
    bool Applied, RecordEditRefusal Refusal, string Message, string? NewFormKey = null, bool EslContradiction = false)
{
    public static RecordEditResult Success() => new(true, RecordEditRefusal.None, "");

    public static RecordEditResult Success(string newFormKey) => new(true, RecordEditRefusal.None, "", newFormKey);

    public static RecordEditResult Refused(RecordEditRefusal refusal, string message) =>
        new(false, refusal, message);

    public static RecordEditResult Refused(RecordEditRefusal refusal, string message, bool eslContradiction) =>
        new(false, refusal, message, EslContradiction: eslContradiction);
}
