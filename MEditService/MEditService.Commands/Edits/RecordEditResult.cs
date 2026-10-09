using System.Text.Json.Serialization;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Edits;

/// <summary>Why an edit was refused (ADR-0019). Each value names a different way out,
/// which is what the message has to say.</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RecordEditRefusal
{
    None,

    /// <summary>The way out is Track, once per mod (ADR-0007).</summary>
    PluginNotTracked,

    /// <summary>The way out is decompile.</summary>
    PluginSourceUnreadable,

    /// <summary>A vanilla/DLC master straight from Data, where Track cannot apply; the way out is a patch plugin.</summary>
    PluginHasNoModFolder,

    /// <summary>The load order names no such plugin.</summary>
    PluginNotInLoadOrder,

    RecordNotFound,

    /// <summary>The path resolves to no member of the schema, or to one the record's own class lacks
    /// (a column only another record class declares, a union member of another leaf).</summary>
    FieldNotFound,

    /// <summary>Permanently unwritable, as masters are (ADR-0008), unlike the state-dependent Partial Form refusal.</summary>
    FieldReadOnly,

    InvalidFormLink,

    /// <summary>Create: no schema table of that name, or the header, which cannot be created this way.</summary>
    RecordTypeNotFound,

    /// <summary>Create: the named container holds no new record of that type where it sits, as xEdit's Add
    /// offers none; a deleted container holds nothing.</summary>
    ContainerCannotHoldType,

    /// <summary>Held at either ref; checked server-side even for an allocator-suggested value, since a caller can type its own.</summary>
    FormKeyCollision,

    /// <summary>Changing an override's FormID would mean changing it across every plugin in the stack; a typed target must be native for the same reason.</summary>
    NotNativeRecord,

    /// <summary>A typed refusal, not an exception: a full plugin is an ordinary outcome, never conflated with "no usable load order".</summary>
    FormKeySpaceExhausted,

    /// <summary>The gesture does not reach the record yet: a type held only inside another record's
    /// document, or a placed record in a grid cell of unknown width.</summary>
    HeldInAnotherRecordNotYetSupported,

    /// <summary>The index and the working tree disagree (a file moved outside Modbench). Not recreated at
    /// a computed path: a container's path lives in the tree, not in a formula.</summary>
    SourceUnitNotFound,

    /// <summary>The file system refused a read or write of the source (ADR-0003), so the message is the file
    /// system's own words, and the way out is outside Modbench.</summary>
    SourceAccessFailed,

    /// <summary>Two documents in the tree claim one FormKey, most likely left by another tool or an
    /// interrupted rename; which to change is the user's call, so the way out is resolving it by hand.</summary>
    AmbiguousSourceUnit,

    /// <summary>A light plugin's slot addresses local IDs only up to 0xFFF; native space is not exhausted,
    /// so the way out differs from <see cref="FormKeySpaceExhausted"/>.</summary>
    LightPluginFormIdOutOfRange,

    /// <summary>A Partial Form record's own fields are never seen by the game; the way out is clearing the
    /// flag. EditorID is exempt: xEdit's <c>CanAssignInternal</c> allows EDID on a Partial Form (ADR-0018).</summary>
    PartialFormFieldReadOnly,

    /// <summary>xEdit's GetCanBePartial refuses the cell a Partial Form: it is temporary and exterior, or
    /// a plugin the game's rule excludes defines it, or neither it nor a copy to its left says which.</summary>
    CannotBePartialForm,

    /// <summary>A reflected column aliasing the flags a synthetic member is one bit of would flip that bit
    /// as a side effect; the synthetic member is the one door onto it, so nothing is written.</summary>
    SyntheticMemberIndirectWrite,

    /// <summary>The write leaves the record Deleted, where xEdit reverts a change to Persistent in silence
    /// (xedit.md, divergence 24).</summary>
    PersistentOnDeletedRecord,

    /// <summary>Neither the placed record's cell nor any copy of it to its left says whether it is
    /// interior or where it sits, or the record has no position to place, so xEdit's destination is unknown.</summary>
    PersistentMoveDestinationUnknown,

    /// <summary>Permanent, matching xEdit: a fresh FormKey for CELL/WRLD leaves the copy with no parent group to sit in.</summary>
    CopyAsNewRecordDisallowedForType,

    /// <summary>A destination loading before the origin would be an underride: the
    /// origin's copy would still win at runtime.</summary>
    UnderrideDestination,

    /// <summary>Copying over the destination's own copy destroys it, so the surface asks first and
    /// then supplies the replace Option; the way out is confirming the replacement.</summary>
    DestinationHoldsRecord,

    /// <summary>The single slot a copied or created child takes holds another record, as a worldspace's
    /// persistent cell, a worldspace's grid position or a cell's landscape does; the way out is outside the gesture.</summary>
    ChildSlotHeldByAnotherRecord,

    /// <summary>A plugin cannot lose its header: the whole-mod door needs it, and its FormKey is synthetic.</summary>
    HeaderDeleteNotSupported,

    /// <summary>The envelope itself is malformed: an unknown operation, a hop naming nothing, a value
    /// missing where the operation needs one, or an operation aimed at a shape it cannot act on.</summary>
    InvalidEnvelope,

    /// <summary>A union element must lead with its discriminator, naming a leaf of the union; the codec
    /// takes the first key as the type and cannot build an object from anything else.</summary>
    DiscriminatorInvalid,

    /// <summary>A byte slice keeps the length the document already holds: nothing here can know which
    /// bytes a resize would move.</summary>
    HexLengthMismatch,

    /// <summary>A colour whose binary form holds no alpha takes none: compile would drop it in silence.
    /// Its own document's alpha 00, which Mutagen's read gives it, is no alpha.</summary>
    AlphaNotHeld,

    /// <summary>Mutagen's reader refused the patched document; the message is its own, verbatim.</summary>
    CodecRejected,

    /// <summary>The codec read the patched document but wrote it back without the value: the schema
    /// named a member the codec has no home for. Never reported as success.</summary>
    CodecDroppedValue,

    /// <summary>The record's own document could not be produced at index time; the diagnosis is the
    /// reason, and repairing it is not a field edit.</summary>
    RecordParseFailed,

    /// <summary>git cannot be run (ADR-0007), a cause no record of a selection escapes
    /// (commands.md, A selection is one gesture).</summary>
    GitUnavailable,
}

/// <summary><see cref="Message"/> names the way out; a refusal the user cannot act on is dead UI.
/// Path is the edited path.</summary>
public sealed record RecordEditResult(
    bool Applied, RecordEditRefusal Refusal, string Message, string? NewFormKey = null, string? Path = null)
{
    internal static RecordEditResult Success() => new(true, RecordEditRefusal.None, "");

    internal static RecordEditResult Success(string newFormKey) => new(true, RecordEditRefusal.None, "", newFormKey);

    internal static RecordEditResult Refused(RecordEditRefusal refusal, string message) =>
        new(false, refusal, message);

    internal static RecordEditResult RefusedAt(RecordEditRefusal refusal, string path, string message) =>
        new(false, refusal, message, Path: path);

    /// <summary>The edit that lands as <paramref name="outcome"/> by making <paramref name="writes"/> through
    /// <paramref name="repository"/> all together, or why they could not be made.</summary>
    internal static Answer<RecordEditResult, SourceFailure> Making(
        RecordEditResult outcome, SourceRepository repository, Action<SourceTransaction> writes) =>
        SourceTransaction.Atomically(repository, writes) is { } failure ? failure : outcome;

    public static implicit operator Answer<RecordEditChanges, SourceFailure>(RecordEditResult outcome) =>
        SourceAnswer.Of<RecordEditChanges>(outcome);
}

/// <summary>An edit answered without writing: its outcome, and the changes it makes to plugin source when
/// it applies.</summary>
public sealed record RecordEditChanges(RecordEditResult Outcome, SourceChanges Changes)
{
    public static implicit operator RecordEditChanges(RecordEditResult outcome) => new(outcome, SourceChanges.None);

    /// <summary><paramref name="outcome"/>, which changes nothing, or why it could not be reached.</summary>
    internal static Answer<RecordEditChanges, SourceFailure> Of(Answer<RecordEditResult, SourceFailure> outcome) =>
        outcome.Then(reached => SourceAnswer.Of<RecordEditChanges>(reached));
}
