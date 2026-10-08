using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>xEdit's Delete, MakePartialForm and their undoing, which refills the copy from the nearest
/// copy to its left that is neither. TwbRecordHeaderStruct.ElementChanged applies Partial Form last, so
/// making one of a deleted copy refills it first.</summary>
internal sealed record RecordEmptying(long Flags, long Changed, bool Deletes, bool MakesPartialForm, bool Refills, bool HeldPersistent)
{
    /// <summary>The emptying a write of <paramref name="value"/> makes, or null when it newly sets and
    /// clears neither flag.</summary>
    internal static RecordEmptying? Of(JsonObject record, RecordTableSchema schema, ColumnSpec column, JsonElement? value)
    {
        if (RecordFlagsWrite.Of(record, schema, column, value) is not { } write) return null;
        var partialFormable = CanBePartial.TypeDeclares(schema.RecordType);
        var makesPartialForm = partialFormable && write.Sets(PartialFormFlag.Bit);
        var deletes = !makesPartialForm && write.Sets(DeletedFlag.Bit);
        var flags = write.Next;
        if (makesPartialForm) flags &= ~DeletedFlag.Bit;
        else if (deletes && partialFormable) flags &= ~PartialFormFlag.Bit;
        var clears = !deletes && (write.Held & ~flags & EmptyingBits(schema)) != 0;
        var deletesBeforeMakingPartialForm = makesPartialForm && write.Sets(DeletedFlag.Bit);
        var refills = clears || deletesBeforeMakingPartialForm;
        if (!deletes && !makesPartialForm && !refills) return null;
        var heldPersistent = (write.Held & PersistentFlag.Bit) != 0;
        return new(flags, write.Held ^ write.Next, deletes, makesPartialForm, refills, heldPersistent);
    }

    /// <summary>The nearest copy to the left of <paramref name="formKey"/> that is neither, on a refill.</summary>
    internal LeftCopy? RefillFrom(LoadOrderResolution.MastersWalk masters, RecordTableSchema schema, string? formKey) =>
        Refills && formKey is not null ? masters.NearestCopy(formKey, _ => true, EmptyingBits(schema)) : null;

    // The flags a copy a refill passes over: Deleted, and Partial Form where the type can be one.
    private static long EmptyingBits(RecordTableSchema schema) =>
        CanBePartial.TypeDeclares(schema.RecordType) ? DeletedFlag.Bit | PartialFormFlag.Bit : DeletedFlag.Bit;

    /// <summary>The refusal of a refill whose nearest copy to the left cannot be read.</summary>
    internal static RecordEditResult? RefuseRefill(LeftCopy? copyOnTheLeft, RecordTableSchema schema, string? formKey, string spelled)
    {
        if (copyOnTheLeft is not LeftCopy.Unreadable unreadable) return null;
        var neither = CanBePartial.TypeDeclares(schema.RecordType) ? "neither Partial Form nor Deleted" : "not Deleted";
        return unreadable.Refusal(spelled, $"{formKey}'s own fields come from its nearest copy to the left that is {neither}");
    }

    /// <summary>The refusal of a Partial Form that xEdit's GetCanBePartial denies the copy.</summary>
    internal RecordEditResult? RefuseCell(
        JsonObject record, IReadOnlyList<PathHop> prefix, RecordTableSchema schema, GameRelease release,
        LoadOrderResolution.MastersWalk masters, string spelled)
    {
        if (!MakesPartialForm) return null;
        var formKey = record[RecordMembers.FormKey]?.GetValue<string>();
        var inPersistentSlot = prefix is [.., { Name: PlacedCell.WorldspacePersistentCellMember }];
        var verdict = CanBePartial.Of(schema, release, formKey, CanBePartial.TemporaryExterior(HeldPersistent, inPersistentSlot, interior: null));
        if (verdict is CanBePartial.Verdict.NeedsPlacement)
        {
            if (masters.WhereItSits(
                record, spelled,
                $"whether {formKey} can be a Partial Form depends on where it sits, which only its nearest copy to the left says",
                () => Cannot(
                    spelled,
                    $"whether {formKey} can be a Partial Form is unknown: it says neither that it is " +
                    "interior nor where it sits in its worldspace, and no copy of it to its left says either"),
                out var said) is { } refusal)
                return refusal;
            verdict = CanBePartial.Of(
                schema, release, formKey, CanBePartial.TemporaryExterior(HeldPersistent, inPersistentSlot, PlacedCell.IsInterior(said)));
        }
        return verdict switch
        {
            CanBePartial.Verdict.TemporaryExterior =>
                Cannot(spelled, $"{formKey} is a temporary exterior cell, which xEdit never makes a Partial Form"),
            CanBePartial.Verdict.DefinedElsewhere(var definedBy, var only) =>
                Cannot(spelled, $"{definedBy} defines {formKey}, and xEdit makes a cell a Partial Form only where {only} defines it"),
            _ => null,
        };
    }

    private static RecordEditResult Cannot(string spelled, string why) =>
        RecordEditResult.RefusedAt(RecordEditRefusal.CannotBePartialForm, spelled, $"'{spelled}': {why}. Nothing was written.");

    /// <summary>xEdit's AssignInternal copies the left copy's flags, but a write ends as it asks (xedit.md,
    /// divergence 25): only the bits it leaves alone take the left copy's. Delete and MakePartialForm clear
    /// Compressed.</summary>
    internal JsonElement FlagsWith(JsonObject? left)
    {
        var flags = left == null ? Flags : (RecordFlagsWrite.HeldBy(left) & ~Changed) | (Flags & Changed);
        if (Deletes || MakesPartialForm) flags &= ~CompressedFlag.Bit;
        return JsonSerializer.SerializeToElement(flags);
    }

    internal void Apply(JsonObject record, RecordTableSchema schema, JsonObject? left)
    {
        foreach (var field in OwnFields(schema))
        {
            var member = field.PropertyName;
            var isEditorId = field.Field.IsEditorId;
            var fromTheLeft = Refills && (!MakesPartialForm || isEditorId);
            if (fromTheLeft && left?[member] is { } value) record[member] = value.DeepClone();
            else if (fromTheLeft || Deletes || !isEditorId) record.Remove(member);
        }
        if (left == null) return;
        if (left[RecordMembers.FormVersion] is { } formVersion) record[RecordMembers.FormVersion] = formVersion.DeepClone();
        else record.Remove(RecordMembers.FormVersion);
        foreach (var stamp in VersionControlStamps(schema)) record[stamp] = 0;
    }

    // xEdit's AssignInternal sets Version Control Info 1 and 2 to 0, each where the game has it.
    private static IEnumerable<string> VersionControlStamps(RecordTableSchema schema) =>
        schema.RecordColumns
            .Select(c => c.PropertyName)
            .Where(member => member is RecordMembers.VersionControlInfo1 or RecordMembers.VersionControlInfo2);

    /// <summary>Makes <paramref name="record"/> a Partial Form as the record-flag edit does. False, changing
    /// nothing, when it already is one.</summary>
    internal static bool MakePartialForm(JsonObject record, RecordTableSchema schema)
    {
        var flags = schema.RecordColumns.Single(c => c.Name == RecordHeaderFlags.Member);
        var write = JsonSerializer.SerializeToElement(RecordFlagsWrite.HeldBy(record) | PartialFormFlag.Bit);
        if (Of(record, schema, flags, write) is not { } emptying) return false;
        ClearAliases(record, flags);
        emptying.Apply(record, schema, left: null);
        record[RecordHeaderFlags.Member] = JsonNode.Parse(emptying.FlagsWith(left: null).GetRawText());
        return true;
    }

    internal static void ClearAliases(JsonObject record, ColumnSpec column)
    {
        JsonNode? owner = record;
        foreach (var segment in (column.Synthetic?.BackingPath ?? column.PropertyName).Split('.')[..^1]) owner = owner?[segment];
        if (owner is not JsonObject members) return;
        foreach (var alias in column.Aliases) members.Remove(alias);
    }

    internal static JsonObject? LeftOf(LeftCopy? copyOnTheLeft) =>
        copyOnTheLeft?.FoundText is { } text ? JsonNode.Parse(text) as JsonObject : null;

    private static IEnumerable<ColumnSpec> OwnFields(RecordTableSchema schema)
    {
        var children = ContainerChildFields.EnumerateChildFieldsFor(schema.RecordType) ?? [];
        return schema.RecordColumns
            .Where(c => !c.Field.IsRecordHeaderMember && !c.Field.IsDiscriminator)
            .Where(c => !children.Contains(c.PropertyName, StringComparer.Ordinal));
    }
}
