namespace MEditService.Core.Schema;

/// <summary>BitValue is the member's bit as a decimal string, so one above 2^53 survives JSON;
/// null for a plain enum's member. Label is null when the value is already the game's own
/// vocabulary.</summary>
public record EnumMember(string Value, string? BitValue = null, string? Label = null);

public record FieldMetadata(
    string Name,
    string Type,
    bool IsArray,
    IReadOnlyList<string> ValidFormKeyTypes,
    // For 'enum': the field's members, in the order the schema lists them. That order is a
    // contract, not a rendering detail — a discriminator's first member is the leaf a new array
    // element is built as (DocumentEdit).
    IReadOnlyList<EnumMember> EnumMembers,
    // For 'array': the element's schema. For 'struct': the sub-field schemas.
    FieldMetadata? ElementType = null,
    IReadOnlyList<FieldMetadata>? Fields = null,

    // The member may be absent-meaning-null rather than absent-meaning-default: a nullable
    // FormLink, a sub-record the getter declares nullable, a member some union leaf lacks.
    bool AllowsNull = false,

    // Null for an ordinary field, whose row label is its own name; set by the abstract-union
    // discriminator, whose name is a wire name.
    string? DisplayLabel = null,             // what to title the row, when Name is a wire name

    // This field is the document's own MutagenObjectType member, naming which concrete class its
    // object is; read off the payload before that object exists (ListLeaves.ResolveListElementType).
    bool IsDiscriminator = false,

    // For an enum whose value decides which sibling fields carry data; null when every sibling is
    // always in use. Keyed by value, not aligned positionally with EnumMembers, so a reordering
    // can never re-point a row.
    IReadOnlyDictionary<string, IReadOnlyList<string>>? SiblingsInUse = null,

    // The element member(s) identifying an element (xEdit's wbArrayS); null for a positional
    // array. Aligned across plugins by key, written back in key order, duplicates refused. A name
    // may be dotted to reach one struct member down.
    IReadOnlyList<string>? KeyMembers = null,

    // For 'struct': the Loqui/CLR class the schema declares, null for every other type. Distinct
    // from a discriminator's value, which says which class an object turned out to be. Serialized
    // nulls stay on all four nullables here.
    string? LeafTypeName = null,

    // A union member whose type differs by leaf: its shape under each leaf, keyed by the
    // discriminator's values. The field's own shape is the first leaf's. Null when every leaf agrees.
    IReadOnlyDictionary<string, FieldMetadata>? Variants = null,

    // What an absent member reads as: the declared default the codec omits on write. Null where
    // that is the wire's own zero (0, false, []); an enum always names it, since its members alone
    // cannot say which is zero.
    object? Default = null,

    // Why this member is never written: a known upstream defect, or a member the header has no
    // write path for. Null for an ordinary member, which the write path patches.
    string? ReadOnlyReason = null);
