using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Core.Edits;

/// <summary>Everything a document edit needs and nothing it may touch: the text, where the edited
/// record sits in it, its schema, the envelope, and the codec round trip as a function.</summary>
internal sealed record DocumentEditRequest(
    string Text,
    IReadOnlyList<PathHop> Prefix,
    RecordTableSchema Schema,
    RecordEditEnvelope Envelope,
    GameRelease Release,
    Func<string, RecordLookupEntry?> Resolve,
    Func<string, string> RoundTrip);

/// <summary>A write is a patch on the document (ADR-0032): resolve the path against the metadata
/// tree, run the closed pre-check list, apply the cascade and the patch, put keyed arrays in key
/// order, read the result through the codec and write it back, and compare what came back with what
/// was asked. Pure: text and metadata in, text or one refusal out.</summary>
internal static class DocumentEdit
{
    private const string EditorIdMember = "EditorID";

    /// <summary>The new document text, or the input text itself when the operation had nothing to do
    /// (an element past the end), in <paramref name="text"/>; a refusal otherwise, with nothing
    /// written anywhere.</summary>
    internal static RecordEditResult? Apply(DocumentEditRequest request, out string text)
    {
        text = request.Text;
        var envelope = request.Envelope;
        var spelled = RecordEditEnvelope.Spell(envelope.Path);
        if (ValidateEnvelope(envelope, spelled) is { } malformed) return malformed;

        if (JsonNode.Parse(request.Text) is not JsonObject root) return Malformed(spelled, "the document is not a JSON object");
        var order = root[SourceChildOrder.OrderMember];
        root.Remove(SourceChildOrder.OrderMember);
        var record = WalkPrefix(root, request.Prefix);
        var before = WalkPrefix((JsonObject)JsonNode.Parse(request.Text)!, request.Prefix);

        var creating = envelope.Op is RecordEditEnvelope.Set or RecordEditEnvelope.Add;
        if (Resolve(record, request.Schema, envelope.Path, creating, out var cursor) is { } unresolved) return unresolved;

        if (RefuseIfPartialForm(record, request.Schema, cursor, spelled) is { } partialForm) return partialForm;

        JsonNode? edited;
        FieldMetadata editedMeta;
        var patched = cursor.Column.Synthetic is { } bit
            ? PatchSyntheticBit(record, bit, envelope, spelled, out edited, out editedMeta)
            : envelope.Op switch
            {
                RecordEditEnvelope.Set => Set(cursor, envelope.Value!.Value, request, spelled, out edited, out editedMeta),
                RecordEditEnvelope.Add => Add(cursor, envelope.Value, request, spelled, out edited, out editedMeta),
                RecordEditEnvelope.Remove => Remove(cursor, out edited, out editedMeta),
                _ => Move(cursor, envelope.Value, out edited, out editedMeta),
            };
        if (patched is { } refused) return refused;
        if (edited is null) return null;

        if (KeyedArrays.Normalize(record, RootMetadata(request.Schema), "") is { } duplicate)
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.DuplicateKeyInKeyedArray, duplicate.Path,
                $"'{duplicate.Path}' has two entries keyed '{duplicate.Key}'. Entries there are " +
                "identified by that key rather than by position, so rename or remove one of the two.");
        }

        var chain = IndexChain(edited!);
        string written;
        try
        {
            written = request.RoundTrip(root.ToJsonString());
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.CodecRejected, spelled, $"'{spelled}': the codec rejected the document — {ex.Message}");
        }

        var writtenRoot = (JsonObject)JsonNode.Parse(written)!;
        if (!Subsumes(At(writtenRoot, chain), edited, editedMeta, spelled, out var dropped))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.CodecDroppedValue, dropped,
                $"'{dropped}' was not kept by the codec: the record's own class has no member the document can carry it in, so nothing was written.");
        }

        var after = WalkPrefix(writtenRoot, request.Prefix);
        foreach (var column in request.Schema.RecordColumns.Where(c => c.Synthetic != null && c != cursor.Column))
        {
            if (IsBitSet(before, column.Synthetic!) != IsBitSet(after, column.Synthetic!))
            {
                return RecordEditResult.RefusedAt(
                    RecordEditRefusal.SyntheticMemberIndirectWrite, spelled,
                    $"'{spelled}' would change '{column.Name}' as a side effect of writing an unrelated column. " +
                    $"That bit is only writable through '{column.Name}' — nothing was written.");
            }
        }

        text = order == null ? written : SourceChildOrder.WithOrder(written, order);
        return null;
    }

    // ── envelope ────────────────────────────────────────────────────────────

    private static RecordEditResult? ValidateEnvelope(RecordEditEnvelope envelope, string spelled)
    {
        if (envelope.Op is not (RecordEditEnvelope.Set or RecordEditEnvelope.Add or RecordEditEnvelope.Remove or RecordEditEnvelope.Move))
            return Malformed(spelled, $"'{envelope.Op}' is not an operation; use set, add, remove or move");
        if (envelope.Path.Count == 0 || envelope.Path[0].Kind != PathHop.MemberKind)
            return Malformed(spelled, "a path starts with a member hop");
        if (envelope.Path.Any(hop => !hop.IsWellFormed))
            return Malformed(spelled, "every hop is a member with a name, an index with a position, or a key with its text");
        if (envelope.Op == RecordEditEnvelope.Set && envelope.Value is null)
            return Malformed(spelled, "set takes a value (JSON null clears a member)");
        if (envelope.Op is RecordEditEnvelope.Remove or RecordEditEnvelope.Move && envelope.Path[^1].Kind == PathHop.MemberKind)
            return Malformed(spelled, $"{envelope.Op} addresses an element, by index or by key");
        if (envelope.Op == RecordEditEnvelope.Move && envelope.Value is not { ValueKind: JsonValueKind.Number })
            return Malformed(spelled, "move takes the destination index as its value");
        return null;
    }

    private static RecordEditResult Malformed(string spelled, string why) =>
        RecordEditResult.RefusedAt(RecordEditRefusal.InvalidEnvelope, spelled, $"'{spelled}': {why}.");

    // ── resolution ──────────────────────────────────────────────────────────

    // Where the path landed: the node (null when the document omits it), its shape, the member spec
    // it was reached through, and the container the last hop addressed it in.
    private sealed class Cursor
    {
        internal required ColumnSpec Column { get; init; }
        internal JsonNode? Node { get; set; }
        internal required FieldMetadata Meta { get; set; }
        internal FieldMetadata? Field { get; set; }
        internal JsonObject? OwnerObject { get; set; }
        internal FieldMetadata? OwnerMeta { get; set; }
        internal string? MemberName { get; set; }
        internal JsonArray? OwnerArray { get; set; }
        internal int Index { get; set; }
    }

    private static RecordEditResult? Resolve(
        JsonObject record, RecordTableSchema schema, IReadOnlyList<PathHop> path, bool creating, out Cursor cursor)
    {
        cursor = null!;
        var spelled = RecordEditEnvelope.Spell(path);
        var name = path[0].Name!;
        var column = schema.RecordColumns.FirstOrDefault(c => c.Name == name);
        if (column == null)
        {
            // The one identity member every record's document spells that no column reflects.
            if (name == EditorIdMember && !schema.IsHeader)
            {
                column = new ColumnSpec(EditorIdMember, EditorIdMember, "VARCHAR", "string", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, AllowsNull: true);
            }
            else
            {
                return RecordEditResult.RefusedAt(
                    RecordEditRefusal.FieldNotFound, spelled, $"'{schema.TableName}' has no field '{name}'.");
            }
        }
        if (column.ReadOnlyReason is { } reason)
            return RecordEditResult.RefusedAt(RecordEditRefusal.FieldReadOnly, spelled, $"'{name}' is read-only: {reason}.");
        if (column.Synthetic != null && path.Count > 1)
            return RecordEditResult.RefusedAt(RecordEditRefusal.FieldNotFound, spelled, $"'{name}' has no members.");

        var meta = column.ToFieldMetadata();
        if (LeafOf(record) is { } recordLeaf && meta.Variants is { } byClass && !byClass.ContainsKey(recordLeaf))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.FieldNotFound, spelled, $"'{recordLeaf}' has no field '{name}'.");
        }

        var segments = column.PropertyName.Split('.');
        var owner = record;
        for (var i = 0; i < segments.Length - 1; i++)
        {
            if (owner[segments[i]] is not JsonObject inner)
            {
                if (!creating) { cursor = new Cursor { Column = column, Meta = meta }; return null; }
                owner[segments[i]] = inner = new JsonObject();
            }
            owner = inner;
        }
        cursor = new Cursor
        {
            Column = column,
            Node = owner[segments[^1]],
            Meta = DocumentNodes.VariantFor(meta, record),
            Field = meta,
            OwnerObject = owner,
            OwnerMeta = RootMetadata(schema),
            MemberName = segments[^1],
        };

        for (var i = 1; i < path.Count; i++)
        {
            var hop = path[i];
            var sofar = RecordEditEnvelope.Spell(path.Take(i + 1));
            if (cursor.OwnerArray != null && cursor.Node == null)
                return RecordEditResult.RefusedAt(RecordEditRefusal.FieldNotFound, sofar, $"'{RecordEditEnvelope.Spell(path.Take(i))}' names no element of the array.");
            if (hop.Kind == PathHop.MemberKind)
            {
                if (cursor.Meta.Fields is not { } fields)
                    return RecordEditResult.RefusedAt(RecordEditRefusal.FieldNotFound, sofar, $"'{RecordEditEnvelope.Spell(path.Take(i))}' has no members.");
                if (cursor.Node is not JsonObject obj)
                {
                    if (cursor.Node != null || !creating)
                        return RecordEditResult.RefusedAt(RecordEditRefusal.FieldNotFound, sofar, $"'{RecordEditEnvelope.Spell(path.Take(i))}' is not present in the document.");
                    obj = new JsonObject();
                    Attach(cursor, obj);
                }
                var field = fields.FirstOrDefault(f => f.Name == hop.Name);
                if (field == null)
                    return RecordEditResult.RefusedAt(RecordEditRefusal.FieldNotFound, sofar, $"'{cursor.Meta.LeafTypeName ?? RecordEditEnvelope.Spell(path.Take(i))}' has no member '{hop.Name}'.");
                if (LeafOf(obj) is { } leaf && field.Variants is { } variants && !variants.ContainsKey(leaf))
                    return RecordEditResult.RefusedAt(RecordEditRefusal.FieldNotFound, sofar, $"'{leaf}' has no member '{hop.Name}'.");

                cursor = new Cursor
                {
                    Column = column,
                    Node = obj[hop.Name!],
                    Meta = DocumentNodes.VariantFor(field, obj),
                    Field = field,
                    OwnerObject = obj,
                    OwnerMeta = cursor.Meta,
                    MemberName = hop.Name,
                };
                continue;
            }

            if (cursor.Meta.ElementType is not { } elementMeta)
                return Malformed(sofar, $"'{RecordEditEnvelope.Spell(path.Take(i))}' is not an array");
            if (cursor.Node is not JsonArray array)
            {
                if (cursor.Node != null)
                    return Malformed(sofar, $"'{RecordEditEnvelope.Spell(path.Take(i))}' is not an array in the document");
                array = new JsonArray();
                if (creating) Attach(cursor, array);
            }
            int index;
            if (hop.Kind == PathHop.IndexKind)
            {
                index = hop.Index!.Value;
            }
            else
            {
                if (cursor.Meta.KeyMembers is not { } keyMembers)
                    return Malformed(sofar, $"'{RecordEditEnvelope.Spell(path.Take(i))}' is not a keyed array; address its elements by position");
                index = -1;
                for (var e = 0; e < array.Count; e++)
                {
                    if (string.Equals(ElementKey.Of(array[e], keyMembers, elementMeta).Text, hop.Key, StringComparison.Ordinal)) { index = e; break; }
                }
            }
            cursor = new Cursor
            {
                Column = column,
                Node = index >= 0 && index < array.Count ? array[index] : null,
                Meta = elementMeta,
                Field = elementMeta,
                OwnerArray = array,
                Index = index,
            };
        }
        return null;
    }

    private static void Attach(Cursor cursor, JsonNode node)
    {
        if (cursor.OwnerObject != null) cursor.OwnerObject[cursor.MemberName!] = node;
        else cursor.OwnerArray![cursor.Index] = node;
        cursor.Node = node;
    }

    private static string? LeafOf(JsonObject? obj) =>
        obj?[LoquiUnions.UnionTypeDiscriminator] is JsonValue value && value.TryGetValue<string>(out var leaf) ? leaf : null;

    private static FieldMetadata RootMetadata(RecordTableSchema schema) =>
        new("", "struct", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            Fields: [.. schema.RecordColumns.Where(c => c.Synthetic == null).Select(c => c.ToFieldMetadata())]);

    // A Partial Form record's own fields are never seen by the game (CONTEXT.md). EditorID is exempt
    // (xEdit's CanAssignInternal, ADR-0034), as is the flag itself: clearing it is the only way out.
    private static RecordEditResult? RefuseIfPartialForm(JsonObject record, RecordTableSchema schema, Cursor cursor, string spelled)
    {
        if (schema.IsHeader || !PartialFormFlag.IsSet(JsonSerializer.SerializeToElement(record), schema.RecordType)) return null;
        if (cursor.Column.Name == EditorIdMember || cursor.Column.Synthetic is { Bit: PartialFormFlag.Bit }) return null;
        return RecordEditResult.RefusedAt(
            RecordEditRefusal.PartialFormFieldReadOnly, spelled,
            $"{record[FormKeyMember]} is a Partial Form override — its own fields are ignored for conflict " +
            "resolution and read-only here. Editing this record requires clearing the Partial " +
            "Form flag on its header first.");
    }

    private const string FormKeyMember = "FormKey";

    // ── the operations ──────────────────────────────────────────────────────

    private static RecordEditResult? Set(
        Cursor cursor, JsonElement value, DocumentEditRequest request, string spelled,
        out JsonNode? edited, out FieldMetadata editedMeta)
    {
        edited = null;
        editedMeta = cursor.Meta;
        if (cursor.OwnerArray != null && cursor.Node == null)
            return RecordEditResult.RefusedAt(RecordEditRefusal.FieldNotFound, spelled, $"'{spelled}' names no element of the array.");
        if (value.ValueKind == JsonValueKind.Null && cursor.OwnerArray != null)
            return Malformed(spelled, "an element is not cleared with null; remove it");

        var node = value.ValueKind == JsonValueKind.Null ? null : JsonNode.Parse(value.GetRawText());
        if (PreCheck(node, cursor.Meta, cursor.Node, spelled) is { } refused) return refused;
        if (CheckErrorBuilder.Build(cursor.Meta, value, request.Resolve, request.Release, absentMeansNull: false) is { } linkError)
            return RecordEditResult.RefusedAt(RecordEditRefusal.InvalidFormLink, spelled, $"'{spelled}': {linkError}");

        if (cursor.OwnerArray != null)
        {
            cursor.OwnerArray[cursor.Index] = node;
            edited = node!;
            return null;
        }

        var owner = cursor.OwnerObject!;
        var field = cursor.Field!;
        if (field.IsDiscriminator)
        {
            if (node is not JsonValue leafValue || !leafValue.TryGetValue<string>(out var leaf) || !field.EnumMembers.Any(m => m.Value == leaf))
                return DiscriminatorRefusal(spelled, field);
            SwitchLeaf(owner, cursor.OwnerMeta!, LeafOf(owner), leaf);
            edited = owner;
            editedMeta = cursor.OwnerMeta!;
            return null;
        }

        if (field.SiblingsInUse is { } inUse)
        {
            // Every slot the table governs is idle unless the new value puts it in use; a stale slot
            // posted under an earlier value is cleared here, never carried.
            var now = InUse(inUse, node, field);
            foreach (var idle in inUse.Values.SelectMany(v => v).Distinct(StringComparer.Ordinal).Except(now, StringComparer.Ordinal))
                owner.Remove(idle);
            if (node == null) owner.Remove(cursor.MemberName!); else owner[cursor.MemberName!] = node;
            edited = owner;
            editedMeta = cursor.OwnerMeta!;
            return null;
        }

        if (node == null)
        {
            owner.Remove(cursor.MemberName!);
            edited = owner;
            editedMeta = cursor.OwnerMeta!;
            return null;
        }
        owner[cursor.MemberName!] = node;
        edited = node;
        return null;
    }

    // The siblings a governing member's value puts in use; an absent member reads as its declared default.
    private static IEnumerable<string> InUse(IReadOnlyDictionary<string, IReadOnlyList<string>> table, JsonNode? value, FieldMetadata field)
    {
        var name = value is JsonValue v && v.TryGetValue<string>(out var s) ? s : field.Default as string;
        return name != null && table.TryGetValue(name, out var siblings) ? siblings : [];
    }

    // The incoming leaf keeps every member it declares in the same shape; the outgoing leaf's own
    // members, and any the incoming leaf shapes differently, are removed so the codec builds the new
    // leaf from what it can hold. The discriminator leads, as the codec requires.
    private static void SwitchLeaf(JsonObject owner, FieldMetadata ownerMeta, string? from, string to)
    {
        foreach (var member in ownerMeta.Fields!.Where(f => f.Variants != null && owner.ContainsKey(f.Name)))
        {
            var kept = member.Variants!.TryGetValue(to, out var incoming)
                && (from == null || !member.Variants.TryGetValue(from, out var outgoing) || SameShape(incoming, outgoing));
            if (!kept) owner.Remove(member.Name);
        }

        var rest = owner.Where(p => p.Key != LoquiUnions.UnionTypeDiscriminator).ToList();
        owner.Clear();
        owner[LoquiUnions.UnionTypeDiscriminator] = to;
        foreach (var (name, node) in rest) owner[name] = node;
    }

    private static bool SameShape(FieldMetadata a, FieldMetadata b) =>
        a.Type == b.Type && a.LeafTypeName == b.LeafTypeName
        && a.ElementType?.Type == b.ElementType?.Type && a.ElementType?.LeafTypeName == b.ElementType?.LeafTypeName;

    private static RecordEditResult? Add(
        Cursor cursor, JsonElement? value, DocumentEditRequest request, string spelled,
        out JsonNode? edited, out FieldMetadata editedMeta)
    {
        edited = null;
        editedMeta = cursor.Meta;
        if (cursor.Meta.ElementType is not { } elementMeta) return Malformed(spelled, $"'{spelled}' is not an array; add appends to one");
        if (cursor.Node is not JsonArray array)
        {
            if (cursor.Node != null) return Malformed(spelled, $"'{spelled}' is not an array in the document");
            array = new JsonArray();
            Attach(cursor, array);
        }

        var element = value is { ValueKind: not JsonValueKind.Null } given
            ? JsonNode.Parse(given.GetRawText())
            : DefaultElement(elementMeta);
        if (PreCheck(element, elementMeta, null, $"{spelled}[{array.Count}]") is { } refused) return refused;
        if (value is { } v && CheckErrorBuilder.Build(elementMeta, v, request.Resolve, request.Release, absentMeansNull: false) is { } linkError)
            return RecordEditResult.RefusedAt(RecordEditRefusal.InvalidFormLink, spelled, $"'{spelled}': {linkError}");
        array.Add(element);
        edited = array;
        return null;
    }

    // "formKey" defaults to "Null", Mutagen's sentinel for an unset FormLink; a struct names only its
    // discriminator, the schema's first leaf, and the codec fills in the rest.
    private static JsonNode? DefaultElement(FieldMetadata meta) => meta.Type switch
    {
        "string" => "",
        "formKey" => "Null",
        "int" or "float" => 0,
        "bool" => false,
        "flags" or "array" => new JsonArray(),
        "enum" => meta.EnumMembers.Count > 0 ? meta.EnumMembers[0].Value : "",
        "hex" => "[]",
        "struct" => DefaultStruct(meta),
        _ => "",
    };

    private static JsonObject DefaultStruct(FieldMetadata meta)
    {
        var element = new JsonObject();
        foreach (var field in meta.Fields ?? [])
            if (field.IsDiscriminator && field.EnumMembers.Count > 0) element[field.Name] = field.EnumMembers[0].Value;
        return element;
    }

    private static RecordEditResult? Remove(Cursor cursor, out JsonNode? edited, out FieldMetadata editedMeta)
    {
        edited = null;
        editedMeta = cursor.Meta;
        if (cursor.OwnerArray is not { } array || cursor.Node == null) return null;   // nothing to remove: already satisfied
        array.RemoveAt(cursor.Index);
        edited = array;
        editedMeta = ArrayMeta(cursor);
        return null;
    }

    private static RecordEditResult? Move(Cursor cursor, JsonElement? value, out JsonNode? edited, out FieldMetadata editedMeta)
    {
        edited = null;
        editedMeta = cursor.Meta;
        if (cursor.OwnerArray is not { } array || cursor.Node == null) return null;
        var destination = value!.Value.GetInt32();
        if (destination < 0 || destination >= array.Count || destination == cursor.Index) return null;
        var node = array[cursor.Index];
        array.RemoveAt(cursor.Index);
        array.Insert(destination, node);
        edited = array;
        editedMeta = ArrayMeta(cursor);
        return null;
    }

    // The array an element cursor sits in has the element's shape as its ElementType; its own key
    // members are what the comparison needs, so the array's metadata is rebuilt around the element's.
    private static FieldMetadata ArrayMeta(Cursor cursor) =>
        new("", "array", true, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, ElementType: cursor.Meta);

    // ── the closed pre-check list ───────────────────────────────────────────

    // Discriminator present and first on a union element, hex length where the document establishes
    // one; walked over the value with the metadata beside it, the current node where the document has one.
    private static RecordEditResult? PreCheck(JsonNode? value, FieldMetadata meta, JsonNode? current, string path)
    {
        switch (value)
        {
            case JsonObject obj when meta.Fields is { } fields:
                var discriminator = fields.FirstOrDefault(f => f.IsDiscriminator);
                if (discriminator != null)
                {
                    var first = obj.FirstOrDefault();
                    if (first.Key != discriminator.Name || first.Value is not JsonValue leafValue
                        || !leafValue.TryGetValue<string>(out var leaf) || !discriminator.EnumMembers.Any(m => m.Value == leaf))
                    {
                        return DiscriminatorRefusal(path, discriminator);
                    }
                }
                var currentObj = current as JsonObject;
                foreach (var (name, child) in obj)
                {
                    if (fields.FirstOrDefault(f => f.Name == name) is not { } field) continue;
                    if (PreCheck(child, DocumentNodes.VariantFor(field, obj), currentObj?[name], $"{path}.{name}") is { } refused) return refused;
                }
                return null;
            case JsonArray array when meta.ElementType is { } elementMeta:
                var currentArray = current as JsonArray;
                for (var i = 0; i < array.Count; i++)
                {
                    if (PreCheck(array[i], elementMeta, currentArray != null && i < currentArray.Count ? currentArray[i] : null, $"{path}[{i}]") is { } refused)
                        return refused;
                }
                return null;
            case JsonValue text when meta.Type == ByteSliceHex.HexApiType:
                if (current is JsonValue held && held.TryGetValue<string>(out var heldHex) && ByteSliceHex.TryParseHex(heldHex, out var heldBytes)
                    && heldBytes.Length > 0 && text.TryGetValue<string>(out var newHex) && ByteSliceHex.TryParseHex(newHex, out var newBytes)
                    && newBytes.Length != heldBytes.Length)
                {
                    return RecordEditResult.RefusedAt(
                        RecordEditRefusal.HexLengthMismatch, path,
                        $"'{path}' holds {heldBytes.Length} bytes; a value of {newBytes.Length} bytes would resize it, and nothing here knows which bytes a resize moves.");
                }
                return null;
            default:
                return null;
        }
    }

    private static RecordEditResult DiscriminatorRefusal(string path, FieldMetadata discriminator) =>
        RecordEditResult.RefusedAt(
            RecordEditRefusal.DiscriminatorInvalid, path,
            $"'{path}' must lead with '{discriminator.Name}' naming one of: {string.Join(", ", discriminator.EnumMembers.Select(m => m.Value))}.");

    // ── synthetic members ───────────────────────────────────────────────────

    private static RecordEditResult? PatchSyntheticBit(
        JsonObject record, SyntheticBit bit, RecordEditEnvelope envelope, string spelled,
        out JsonNode? edited, out FieldMetadata editedMeta)
    {
        edited = null;
        editedMeta = new("", "struct", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);
        if (envelope.Op != RecordEditEnvelope.Set || envelope.Value is not { ValueKind: JsonValueKind.True or JsonValueKind.False } value)
            return Malformed(spelled, $"'{spelled}' takes a JSON boolean through set");
        var set = value.GetBoolean();

        var segments = bit.BackingPath.Split('.');
        var owner = record;
        foreach (var segment in segments[..^1])
        {
            if (owner[segment] is not JsonObject inner) owner[segment] = inner = new JsonObject();
            owner = inner;
        }
        var member = segments[^1];
        if (bit.BackingNames.Count == 0)
        {
            var raw = owner[member] is JsonValue held && held.TryGetValue<long>(out var flags) ? flags : 0;
            var next = set ? raw | bit.Bit : raw & ~bit.Bit;
            if (next == 0) owner.Remove(member); else owner[member] = next;
            foreach (var alias in bit.Aliases) owner.Remove(alias);
        }
        else
        {
            var name = bit.BackingNames.Single(m => long.Parse(m.BitValue!, CultureInfo.InvariantCulture) == bit.Bit).Value;
            var names = (owner[member] as JsonArray)?.Select(n => n!.GetValue<string>()).Where(n => n != name).ToList() ?? [];
            if (set) names.Add(name);
            if (names.Count == 0) owner.Remove(member); else owner[member] = new JsonArray([.. names.Select(n => (JsonNode)n)]);
        }
        edited = owner;
        return null;
    }

    private static bool IsBitSet(JsonObject record, SyntheticBit bit)
    {
        JsonNode? node = record;
        foreach (var segment in bit.BackingPath.Split('.')) node = (node as JsonObject)?[segment];
        return node switch
        {
            JsonValue raw when raw.TryGetValue<long>(out var flags) => (flags & bit.Bit) != 0,
            JsonArray names => names.Any(n => bit.BackingNames.Any(m => m.Value == n!.GetValue<string>() && long.Parse(m.BitValue!, CultureInfo.InvariantCulture) == bit.Bit)),
            _ => false,
        };
    }

    // ── the silent-skip guard ───────────────────────────────────────────────

    // What came back holds what was asked: every member the patch spelled is present, in whatever
    // spelling the codec normalized it to, unless it was the default the codec omits. A member the
    // codec dropped names the failure.
    private static bool Subsumes(JsonNode? written, JsonNode? patched, FieldMetadata? meta, string path, out string dropped)
    {
        dropped = "";
        if (patched is null) return true;
        if (written is null)
        {
            if (IsDefaultLike(patched, meta)) return true;
            dropped = path;
            return false;
        }
        switch (patched)
        {
            case JsonObject po when written is JsonObject wo:
                foreach (var (name, pv) in po)
                {
                    var memberMeta = meta?.Fields?.FirstOrDefault(f => f.Name == name) is { } f ? DocumentNodes.VariantFor(f, po) : null;
                    var memberPath = path.Length == 0 ? name : $"{path}.{name}";
                    if (!wo.TryGetPropertyValue(name, out var wv))
                    {
                        if (pv is null || IsDefaultLike(pv, memberMeta)) continue;
                        dropped = memberPath;
                        return false;
                    }
                    if (!Subsumes(wv, pv, memberMeta, memberPath, out dropped)) return false;
                }
                return true;
            case JsonArray pa when written is JsonArray wa:
                if (meta?.Type == "flags")
                {
                    if (FlagBits(wa, meta) is { } wb && FlagBits(pa, meta) is { } pb && wb == pb) return true;
                    dropped = path;
                    return false;
                }
                if (wa.Count != pa.Count)
                {
                    dropped = path;
                    return false;
                }
                for (var i = 0; i < pa.Count; i++)
                {
                    if (!Subsumes(wa[i], pa[i], meta?.ElementType, $"{path}[{i}]", out dropped)) return false;
                }
                return true;
            case JsonValue patchedLeaf:
                if (written is JsonValue writtenLeaf && LeafEquivalent(writtenLeaf, patchedLeaf, meta)) return true;
                dropped = path;
                return false;
            default:
                dropped = path;
                return false;
        }
    }

    // What the codec may change in a leaf it kept: the spelling, never the value. Flags compare as
    // bits, since the codec names a defined bit and spells an undefined one in hex.
    private static bool LeafEquivalent(JsonValue written, JsonValue patched, FieldMetadata? meta)
    {
        var w = JsonSerializer.SerializeToElement(written);
        var p = JsonSerializer.SerializeToElement(patched);
        if (w.ValueKind != p.ValueKind) return false;
        if (w.ValueKind != JsonValueKind.String) return DocumentNodes.SameValue(w, p);
        var (ws, ps) = (w.GetString()!, p.GetString()!);
        return meta?.Type switch
        {
            ByteSliceHex.HexApiType or "color" => string.Equals(ws.TrimStart('#'), ps.TrimStart('#'), StringComparison.OrdinalIgnoreCase)
                || string.Equals(StripHexPrefix(ws), StripHexPrefix(ps), StringComparison.OrdinalIgnoreCase),
            "formKey" => Mutagen.Bethesda.Plugins.FormKey.TryFactory(ws, out var wk) && Mutagen.Bethesda.Plugins.FormKey.TryFactory(ps, out var pk) && wk == pk,
            "vector" => Components(ws).SequenceEqual(Components(ps)),
            _ => string.Equals(ws, ps, StringComparison.Ordinal),
        };
    }

    private static string StripHexPrefix(string text) =>
        text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? text[2..] : text;

    private static IEnumerable<double> Components(string vector) =>
        vector.Split(',').Select(c => double.TryParse(c.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : double.NaN);

    // A flags array as the bits it names: a member by its declared bit, anything else as the
    // number it spells (decimal or hex), which is how the codec spells a bit no member names.
    private static long? FlagBits(JsonArray names, FieldMetadata? meta)
    {
        long bits = 0;
        foreach (var name in names)
        {
            var text = name?.ToString() ?? "";
            var member = meta?.EnumMembers.FirstOrDefault(m => m.Value == text);
            if (member?.BitValue is { } declared) bits |= long.Parse(declared, CultureInfo.InvariantCulture);
            else if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) && long.TryParse(text.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var hex)) bits |= hex;
            else if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number)) bits |= number;
            else return null;
        }
        return bits;
    }

    private static bool IsDefaultLike(JsonNode? node, FieldMetadata? meta)
    {
        if (node is null) return true;
        if (meta?.IsDiscriminator == true) return false;
        if (meta?.Default is { } declared)
        {
            return declared is string[] flags && node is JsonArray names
                ? names.Select(n => n?.ToString()).ToHashSet(StringComparer.Ordinal).SetEquals(flags)
                : DocumentNodes.SameValue(JsonSerializer.SerializeToElement(node), JsonSerializer.SerializeToElement(declared));
        }
        return node switch
        {
            JsonValue value => IsZero(value, meta),
            JsonArray array => array.Count == 0,
            JsonObject obj => obj.All(p => IsDefaultLike(p.Value, meta?.Fields?.FirstOrDefault(f => f.Name == p.Key) is { } f ? DocumentNodes.VariantFor(f, obj) : null)),
            _ => false,
        };
    }

    private static bool IsZero(JsonValue value, FieldMetadata? meta)
    {
        var element = JsonSerializer.SerializeToElement(value);
        return element.ValueKind switch
        {
            JsonValueKind.False => true,
            JsonValueKind.Number => element.GetDouble().CompareTo(0d) == 0,
            JsonValueKind.String => element.GetString() is { } s
                && (s.Length == 0 || (s == "Null" && meta?.Type == "formKey") || (s == "[]" && meta?.Type == ByteSliceHex.HexApiType)),
            _ => false,
        };
    }

    // ── walking ─────────────────────────────────────────────────────────────

    private static JsonObject WalkPrefix(JsonObject root, IReadOnlyList<PathHop> prefix)
    {
        JsonNode? node = root;
        foreach (var hop in prefix)
            node = hop.Kind == PathHop.MemberKind ? (node as JsonObject)?[hop.Name!] : (node as JsonArray)?[hop.Index!.Value];
        return node as JsonObject
            ?? throw new InvalidOperationException($"The document has no object at {RecordEditEnvelope.Spell(prefix)}.");
    }

    // The node's place from the root, by member name and by position, read after keyed arrays were
    // put in key order so the same chain addresses it in what the codec wrote back.
    private static List<object> IndexChain(JsonNode node)
    {
        var chain = new List<object>();
        for (var current = node; current.Parent != null; current = current.Parent)
            chain.Insert(0, current.Parent is JsonArray ? current.GetElementIndex() : current.GetPropertyName());
        return chain;
    }

    private static JsonNode? At(JsonNode root, List<object> chain)
    {
        JsonNode? node = root;
        foreach (var step in chain)
        {
            if (step is int index) node = node is JsonArray array && index < array.Count ? array[index] : null;
            else node = (node as JsonObject)?[(string)step];
            if (node == null) return null;
        }
        return node;
    }
}
