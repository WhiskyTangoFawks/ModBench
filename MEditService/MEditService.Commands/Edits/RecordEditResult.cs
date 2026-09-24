using System.Text.Json.Serialization;

namespace MEditService.Commands.Edits;

/// <summary>Why an edit was refused, typed rather than a string to match on (ADR-0019). Each value
/// names a different way out, which is what the message has to say.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RecordEditRefusal
{
    None,

    /// <summary>The way out is Track, once per mod (ADR-0007: the friction is deliberate).</summary>
    PluginNotTracked,

    /// <summary>A vanilla/DLC master straight from Data, where Track cannot apply; the way out is a patch plugin.</summary>
    PluginHasNoModFolder,

    RecordNotFound,

    /// <summary>The path resolves to no member of the schema, or to one the record's own class lacks
    /// (a column only another record class declares, a union member of another leaf).</summary>
    FieldNotFound,

    /// <summary>Permanently unwritable (masters are compile-derived, ADR-0008), unlike the state-dependent Partial Form refusal.</summary>
    FieldReadOnly,

    InvalidFormLink,

    /// <summary>Refused per mod, compile included, until the Absorb/Keep dialog is answered; the way out is answering it.</summary>
    ExternalChangeUnanswered,

    /// <summary>Create: no schema table of that name, or the header, which cannot be created this way.</summary>
    RecordTypeNotFound,

    /// <summary>Held at either ref; checked server-side even for an allocator-suggested value, since a caller can type its own.</summary>
    FormKeyCollision,

    /// <summary>Renumbering an override would mean renumbering it across every plugin in the stack; a typed target must be native for the same reason.</summary>
    NotNativeRecord,

    /// <summary>A typed refusal, not an exception: a full plugin is an ordinary outcome, never conflated with "no usable load order".</summary>
    FormKeySpaceExhausted,

    /// <summary>No flat source path: a container's own directory, or a child embedded in one. A new
    /// record has no containment until a gesture asks for it, which is a UX decision.</summary>
    ContainerRecordNotYetSupported,

    /// <summary>The index and the working tree disagree (a file moved outside Modbench). Not recreated at
    /// a computed path: a container's path lives in the tree, not in a formula.</summary>
    SourceUnitNotFound,

    /// <summary>The file system refused the write: the tree is not Modbench's alone (ADR-0003), so the
    /// message is the file system's own words, and the way out is outside Modbench.</summary>
    SourceWriteFailed,

    /// <summary>Two documents in the tree claim one FormKey, most likely left by another tool or an
    /// interrupted rename; which to change is the user's call, so the way out is resolving it by hand.</summary>
    AmbiguousSourceUnit,

    /// <summary>A light plugin's slot addresses local IDs only up to 0xFFF; native space is not exhausted,
    /// so the way out differs from <see cref="FormKeySpaceExhausted"/>.</summary>
    LightPluginFormIdOutOfRange,

    /// <summary>A Partial Form record's own fields are never seen by the game; the way out is clearing the
    /// flag. EditorID is exempt: xEdit's <c>CanAssignInternal</c> allows EDID on a Partial Form (ADR-0018).</summary>
    PartialFormFieldReadOnly,

    /// <summary>A reflected column aliasing the flags a synthetic member is one bit of would flip that bit
    /// as a side effect; the synthetic member is the one door onto it, so nothing is written.</summary>
    SyntheticMemberIndirectWrite,

    /// <summary>The missing ancestor is exterior with no spatial placement to mint from (a TopCell, or no
    /// parent worldspace); an interior Cell auto-creates instead, since its placement carries no meaning.</summary>
    ContainerParentMissingInDestination,

    /// <summary>Permanent, matching xEdit: a fresh FormKey for CELL/WRLD leaves the copy with no parent group to sit in.</summary>
    CopyAsNewRecordDisallowedForType,

    /// <summary>A destination loading before the origin would be an underride: the
    /// origin's copy would still win at runtime.</summary>
    UnderrideDestination,

    /// <summary>Entries in a keyed array are identified by key, not position, so a second one is a
    /// collision; the message names the key.</summary>
    DuplicateKeyInKeyedArray,

    /// <summary>Deleting the header would remove the root <c>RecordData.json</c> the whole-mod door needs;
    /// its FormKey is synthetic. Refused before <c>HoldingUnit.IsDirectoryPerRecord</c>, whose filename-only
    /// test would delete the whole source root.</summary>
    HeaderDeleteOrRenumberNotSupported,

    /// <summary>The envelope itself is malformed: an unknown operation, a hop naming nothing, a value
    /// missing where the operation needs one, or an operation aimed at a shape it cannot act on.</summary>
    InvalidEnvelope,

    /// <summary>A union element must lead with its discriminator, naming a leaf of the union; the codec
    /// takes the first key as the type and cannot build an object from anything else.</summary>
    DiscriminatorInvalid,

    /// <summary>A byte slice keeps the length the document already holds: nothing here can know which
    /// bytes a resize would move.</summary>
    HexLengthMismatch,

    /// <summary>Mutagen's reader refused the patched document; the message is its own, verbatim.</summary>
    CodecRejected,

    /// <summary>The codec read the patched document but wrote it back without the value: the schema
    /// named a member the codec has no home for. Never reported as success.</summary>
    CodecDroppedValue,

    /// <summary>The record's own document could not be produced at index time; the diagnosis is the
    /// reason, and repairing it is not a field edit.</summary>
    RecordParseFailed,

    /// <summary>git cannot be run, which no record of a selection escapes, so the whole selection is
    /// refused once; the way out is putting git on the PATH (ADR-0007).</summary>
    GitUnavailable,
}

/// <summary><see cref="Message"/> names the way out; a refusal the user cannot act on is dead UI.
/// Path is the edited path. EslContradiction marks a FormKeySpaceExhausted the removable ESL flag
/// alone causes, so the frontend can prompt.</summary>
public sealed record RecordEditResult(
    bool Applied, RecordEditRefusal Refusal, string Message, string? NewFormKey = null, bool EslContradiction = false,
    string? Path = null)
{
    public static RecordEditResult Success() => new(true, RecordEditRefusal.None, "");

    public static RecordEditResult Success(string newFormKey) => new(true, RecordEditRefusal.None, "", newFormKey);

    public static RecordEditResult Refused(RecordEditRefusal refusal, string message) =>
        new(false, refusal, message);

    public static RecordEditResult Refused(RecordEditRefusal refusal, string message, bool eslContradiction) =>
        new(false, refusal, message, EslContradiction: eslContradiction);

    public static RecordEditResult RefusedAt(RecordEditRefusal refusal, string path, string message) =>
        new(false, refusal, message, Path: path);
}
