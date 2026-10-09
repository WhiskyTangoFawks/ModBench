using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>Everything a record's edit needs and nothing it may touch: its own document, the container record that
/// holds it if any, and the walk to the left that a cell's place and a refill read.</summary>
internal sealed record RecordTextEditRequest(
    Document Record,
    HeldIn? Held,
    RecordTableSchema Schema,
    RecordEditEnvelope Envelope,
    GameRelease Release,
    Func<string, string> RoundTrip,
    LoadOrderResolution.MastersWalk Masters);

/// <summary>A write is an edit by path on the record's own document (ADR-0005), refused by the rules that
/// decide a write. Pure: a document and metadata in, text or one refusal out.</summary>
internal static class RecordTextEdit
{
    /// <summary>The record's new text in <paramref name="text"/> on success (a null return), and the group it
    /// moves into; a refusal otherwise, with nothing written anywhere.</summary>
    internal static RecordEditResult? Patch(RecordTextEditRequest request, out string text, out CellGroupMove? move)
    {
        text = "";
        move = null;
        var envelope = request.Envelope;
        var spelled = RecordEditEnvelope.Spell(envelope.Path);
        if (ValidateEnvelope(envelope, spelled, out var op) is { } malformed) return malformed;

        var record = request.Record;
        if (DocumentEdit.Locate(record, request.Schema, op, [.. envelope.Path.Select(hop => hop.Hop)], out var located) is { } unaddressed)
            return Refusal(unaddressed);
        var edit = located ?? throw new InvalidOperationException("Expected Locate to answer an edit when it does not refuse.");
        if (edit.ReadOnlyTarget is { } readOnly) return ReadOnlyRefusal(readOnly.Path, readOnly.Member, readOnly.Reason);
        var column = edit.Column;

        if (RefuseIfPartialForm(record, request.Schema, column, spelled) is { } partialForm) return partialForm;

        var requested = RecordFlagsWrite.Requested(request.Schema, column, envelope.Value);
        var emptying = RecordEmptying.Of(record, request.Schema, requested);
        if (emptying?.RefuseCell(record, request.Held, request.Schema, request.Release, request.Masters, spelled) is { } cannot)
            return cannot;
        var formKey = record.StringAt(RecordMembers.FormKey);
        var refill = emptying?.RefillFrom(request.Masters, request.Schema, formKey);
        if (RecordEmptying.RefuseRefill(refill, request.Schema, formKey, spelled) is { } unreadable)
            return unreadable;
        var left = RecordEmptying.LeftOf(refill);
        if (emptying != null) requested = emptying.FlagsWith(left);
        if (RefusePersistentOnDeleted(record, request, column, requested, spelled) is { } deleted) return deleted;
        var groupMove = CellGroupMove.Of(record, request.Held, requested);
        AnotherCell? into = null;
        if (groupMove?.RefuseUnknownCell(record, request.Release, request.Masters, spelled, out into) is { } unknown) return unknown;

        if (op == EditOp.Move && RefuseMove(edit, envelope, spelled) is { } unmoved) return unmoved;
        var value = envelope.Value?.RawText;
        if (edit.ReadOnlyReached(value) is { } reached) return ReadOnlyRefusal(reached.Path, reached.Member, reached.Reason);
        if (edit.Apply(value, out var applied) is { } refused) return Refusal(refused);
        var patch = applied ?? throw new InvalidOperationException("Expected Apply to answer a patch when it does not refuse.");
        var patched = emptying?.Apply(patch.Document, request.Schema, request.Release, left) ?? patch.Document;

        string written;
        try
        {
            written = request.RoundTrip(patched.Text);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.CodecRejected, spelled, $"'{spelled}': the codec rejected the document — {ex.Message}");
        }

        var after = Document.Parse(written);
        if (patch.FirstDropped(patched, after) is { } dropped)
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.CodecDroppedValue, dropped,
                $"'{dropped}' was not kept by the codec: the record's own class has no member the document can carry it in, so nothing was written.");
        }

        foreach (var other in request.Schema.RecordColumns)
        {
            if (other.Synthetic is not { } synthetic || other == column) continue;
            if (SyntheticBits.IsSet(record, synthetic) != SyntheticBits.IsSet(after, synthetic))
            {
                return RecordEditResult.RefusedAt(
                    RecordEditRefusal.SyntheticMemberIndirectWrite, spelled,
                    $"'{spelled}' would change '{other.Name}' as a side effect of writing an unrelated column. " +
                    $"That bit is only writable through '{other.Name}' — nothing was written.");
            }
        }

        text = written;
        move = groupMove is null ? null : groupMove with { Into = into };
        return null;
    }

    // ── envelope ────────────────────────────────────────────────────────────

    private static RecordEditResult? ValidateEnvelope(RecordEditEnvelope envelope, string spelled, out EditOp op)
    {
        op = default;
        switch (envelope.Op)
        {
            case RecordEditEnvelope.Set: op = EditOp.Set; break;
            case RecordEditEnvelope.Add: op = EditOp.Add; break;
            case RecordEditEnvelope.Remove: op = EditOp.Remove; break;
            case RecordEditEnvelope.Move: op = EditOp.Move; break;
            default: return Malformed(spelled, $"'{envelope.Op}' is not an operation; use set, add, remove or move");
        }
        if (envelope.Path.Count == 0 || envelope.Path[0].Kind != PathHop.MemberKind)
            return Malformed(spelled, "a path starts with a member hop");
        if (envelope.Path.Any(hop => !WellFormed(hop)))
            return Malformed(spelled, "every hop is a member with a name or an index with a position");
        if (op == EditOp.Set && envelope.Value is null)
            return Malformed(spelled, "set takes a value (JSON null clears a member)");
        if (op is EditOp.Remove or EditOp.Move && envelope.Path[^1].Kind == PathHop.MemberKind)
            return Malformed(spelled, $"{envelope.Op} addresses an element by its index");
        if (op == EditOp.Move && envelope.Value is not { Kind: EditValueKind.Number })
            return Malformed(spelled, "move takes the destination index as its value");
        return null;
    }

    // A hop names exactly what its kind needs.
    private static bool WellFormed(PathHop hop) => hop.Kind switch
    {
        PathHop.MemberKind => hop.Name is { Length: > 0 } && hop.Index is null,
        PathHop.IndexKind => hop.Index is >= 0 && hop.Name is null,
        _ => false,
    };

    private static RecordEditResult Malformed(string spelled, string why) =>
        RecordEditResult.RefusedAt(RecordEditRefusal.InvalidEnvelope, spelled, $"'{spelled}': {why}.");

    private static RecordEditResult NotFound(string spelled, string why) =>
        RecordEditResult.RefusedAt(RecordEditRefusal.FieldNotFound, spelled, why);

    private static RecordEditResult Refusal(EditFailure failure) => failure switch
    {
        EditFailure.NoField(var path, var owner, var field) => NotFound(path, $"'{owner}' has no field '{field}'."),
        EditFailure.NoMember(var path, var owner, var member) => NotFound(path, $"'{owner}' has no member '{member}'."),
        EditFailure.NoMembers(var path, var subject) => NotFound(path, $"'{subject}' has no members."),
        EditFailure.Absent(var path, var subject) => NotFound(path, $"'{subject}' is not present in the document."),
        EditFailure.NoElement(var path, var count) =>
            NotFound(path, $"'{path}' names no element: the array holds {count} element(s), so nothing was written."),
        EditFailure.NotAnArray(var path, var subject, var inTheDocument) =>
            Malformed(path, inTheDocument ? $"'{subject}' is not an array in the document" : $"'{subject}' is not an array"),
        EditFailure.NoArrayToAppendTo(var path) => Malformed(path, $"'{path}' is not an array; add appends to one"),
        EditFailure.NullElement(var path) => Malformed(path, "an element is not cleared with null; remove it"),
        EditFailure.NotABoolean(var path) => Malformed(path, $"'{path}' takes a JSON boolean through set"),
        EditFailure.NotALeaf(var path, var discriminator) => RecordEditResult.RefusedAt(
            RecordEditRefusal.DiscriminatorInvalid, path,
            $"'{path}' must lead with '{discriminator.Name}' naming one of: {string.Join(", ", discriminator.EnumMembers.Select(m => m.Value))}."),
        EditFailure.HexResize(var path, var held, var given) => RecordEditResult.RefusedAt(
            RecordEditRefusal.HexLengthMismatch, path,
            $"'{path}' holds {held} bytes; a value of {given} bytes would resize it, and nothing here knows which bytes a resize moves."),
        EditFailure.AlphaGiven(var path, var color) => RecordEditResult.RefusedAt(
            RecordEditRefusal.AlphaNotHeld, path,
            $"'{path}' holds no alpha; '{color}' gives one that compiling would drop, so nothing was written. Give it as #RRGGBB."),
        _ => throw new InvalidOperationException($"Expected a refusal for every edit failure, not {failure.GetType().Name}."),
    };

    private static RecordEditResult? RefuseMove(DocumentEdit edit, RecordEditEnvelope envelope, string spelled)
    {
        // xedit.md, divergence 14.
        if (edit.InKeyedArray)
            return Malformed(spelled, $"'{RecordEditEnvelope.Spell(envelope.Path.SkipLast(1))}' is a keyed array, and a keyed array's elements take no move");
        var destination = (envelope.Value ?? throw new InvalidOperationException("Expected a move's destination index.")).Integer;
        return destination == edit.Position ? Malformed(spelled, $"the element is already at position {destination}") : null;
    }

    internal static RecordEditResult ReadOnlyRefusal(string path, string name, string reason) =>
        RecordEditResult.RefusedAt(RecordEditRefusal.FieldReadOnly, path, $"'{name}' is read-only: {reason}.");

    // A Partial Form record's own fields are never seen by the game (CONTEXT.md). Its EditorID and
    // record header edit (editor-fields.md § Partial Form), as does the flag itself.
    private static RecordEditResult? RefuseIfPartialForm(Document record, RecordTableSchema schema, ColumnSpec column, string spelled)
    {
        if (!schema.IsPartialForm(record)) return null;
        if (column.Field.IsEditorId || column.Field.IsRecordHeaderMember) return null;
        return RecordEditResult.RefusedAt(
            RecordEditRefusal.PartialFormFieldReadOnly, spelled,
            $"{record.StringAt(RecordMembers.FormKey)} is a Partial Form override — its own fields are ignored for conflict " +
            "resolution and read-only here. Editing this record requires clearing the Partial " +
            "Form flag on its header first.");
    }

    // xEdit applies a write's Deleted before its Persistent, and reverts Persistent on a record that
    // then reads Deleted (xedit.md, divergence 24).
    private static RecordEditResult? RefusePersistentOnDeleted(
        Document record, RecordTextEditRequest request, ColumnSpec column, long? requested, string spelled)
    {
        if (RecordFlagsWrite.Of(record, requested) is not { } write
            || (write.Next & DeletedFlag.Bit) == 0 || !write.Changes(PersistentFlag.Bit)
            || !(request.Held is { IsPlaced: true } || column.Field.EnumMembers.Any(NamesPersistent)))
            return null;
        return RecordEditResult.RefusedAt(
            RecordEditRefusal.PersistentOnDeletedRecord, spelled,
            $"{record.StringAt(RecordMembers.FormKey)} is Deleted once this write lands, and a Deleted record's Persistent " +
            "does not change. Nothing was written.");
    }

    // A placed record's bit 10 is always Persistent, which its type's flag enums may leave unnamed. Elsewhere
    // the bit is Persistent only where Mutagen names it so: other types give it other meanings.
    private const string PersistentName = "Persistent";

    private static bool NamesPersistent(EnumMember flag) =>
        flag.Value == PersistentName
        && flag.BitValue == PersistentFlag.Bit.ToString(System.Globalization.CultureInfo.InvariantCulture);
}
