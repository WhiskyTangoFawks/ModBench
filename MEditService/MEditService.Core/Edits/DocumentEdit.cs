using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

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

/// <summary>A write is a patch on the document (ADR-0032): resolve, pre-check, cascade, patch, key
/// order, codec round trip, compare what came back with what was asked. Pure: text and metadata
/// in, text or one refusal out.</summary>
internal static class DocumentEdit
{
    private const string EditorIdMember = nameof(IMajorRecordGetter.EditorID);
    private const string FormKeyMember = nameof(IMajorRecordGetter.FormKey);

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
                _ => Move(cursor, envelope.Value, spelled, out edited, out editedMeta),
            };
        if (patched is { } refused) return refused;

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
        if (!SilentSkipGuard.Keeps(At(writtenRoot, chain), edited, editedMeta, spelled, out var dropped))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.CodecDroppedValue, dropped,
                $"'{dropped}' was not kept by the codec: the record's own class has no member the document can carry it in, so nothing was written.");
        }

        var after = JsonSerializer.SerializeToElement(WalkPrefix(writtenRoot, request.Prefix));
        var was = JsonSerializer.SerializeToElement(before);
        foreach (var column in request.Schema.RecordColumns.Where(c => c.Synthetic != null && c != cursor.Column))
        {
            if (SyntheticBits.IsSet(was, column.Synthetic!) != SyntheticBits.IsSet(after, column.Synthetic!))
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
        if (envelope.Path.Any(hop => !WellFormed(hop)))
            return Malformed(spelled, "every hop is a member with a name, an index with a position, or a key with its text");
        if (envelope.Op == RecordEditEnvelope.Set && envelope.Value is null)
            return Malformed(spelled, "set takes a value (JSON null clears a member)");
        if (envelope.Op is RecordEditEnvelope.Remove or RecordEditEnvelope.Move && envelope.Path[^1].Kind == PathHop.MemberKind)
            return Malformed(spelled, $"{envelope.Op} addresses an element, by index or by key");
        if (envelope.Op == RecordEditEnvelope.Move && envelope.Value is not { ValueKind: JsonValueKind.Number })
            return Malformed(spelled, "move takes the destination index as its value");
        return null;
    }

    // A hop names exactly what its kind needs.
    private static bool WellFormed(PathHop hop) => hop.Kind switch
    {
        PathHop.MemberKind => hop.Name is { Length: > 0 } && hop.Index is null && hop.Key is null,
        PathHop.IndexKind => hop.Index is >= 0 && hop.Name is null && hop.Key is null,
        PathHop.KeyKind => hop.Key is not null && hop.Name is null && hop.Index is null,
        _ => false,
    };

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
                column = new ColumnSpec(
                    new SubFieldSpec(EditorIdMember, "string", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, AllowsNull: true),
                    EditorIdMember, "VARCHAR");
            }
            else
            {
                return RecordEditResult.RefusedAt(
                    RecordEditRefusal.FieldNotFound, spelled, $"'{schema.TableName}' has no field '{name}'.");
            }
        }
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
            // An element that is not there is a path the document does not know, on every operation:
            // a stale panel must never hear that a write which did nothing landed.
            if (index < 0 || index >= array.Count) return NoElement(sofar, array.Count);
            cursor = new Cursor
            {
                Column = column,
                Node = array[index],
                Meta = elementMeta,
                Field = elementMeta,
                OwnerArray = array,
                Index = index,
            };
        }

        // Asked once, of whatever the path resolved to: a read-only member has no members of its
        // own, so no path can pass through one to reach something writable below it.
        return cursor.Field?.ReadOnlyReason is { } why
            ? ReadOnlyRefusal(spelled, cursor.MemberName ?? name, why)
            : null;
    }

    private static RecordEditResult ReadOnlyRefusal(string path, string name, string reason) =>
        RecordEditResult.RefusedAt(RecordEditRefusal.FieldReadOnly, path, $"'{name}' is read-only: {reason}.");

    private static RecordEditResult NoElement(string spelled, int count) =>
        RecordEditResult.RefusedAt(
            RecordEditRefusal.FieldNotFound, spelled,
            $"'{spelled}' names no element: the array holds {count} element(s), so nothing was written.");

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

    // ── the operations ──────────────────────────────────────────────────────

    private static RecordEditResult? Set(
        Cursor cursor, JsonElement value, DocumentEditRequest request, string spelled,
        out JsonNode? edited, out FieldMetadata editedMeta)
    {
        edited = null;
        editedMeta = cursor.Meta;
        if (value.ValueKind == JsonValueKind.Null && cursor.OwnerArray != null)
            return Malformed(spelled, "an element is not cleared with null; remove it");

        var node = value.ValueKind == JsonValueKind.Null ? null : JsonNode.Parse(value.GetRawText());
        if (PreCheck(node, cursor.Meta, cursor.Node, spelled) is { } refused) return refused;
        Cascade(node, cursor.Meta, cursor.Node);
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
            // A stale slot posted under an earlier value is cleared here, never carried.
            foreach (var idle in Idle(inUse, node, field)) owner.Remove(idle);
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

    // The cascade over a whole value: wherever it changes a governing member from what the document
    // holds, only the slots the new value uses stay, so a stale slot cannot ride in beside it. An
    // unchanged member idles nothing.
    private static void Cascade(JsonNode? value, FieldMetadata meta, JsonNode? current)
    {
        switch (value)
        {
            case JsonObject obj when meta.Fields is { } fields:
                var was = current as JsonObject;
                foreach (var field in fields)
                {
                    if (field.SiblingsInUse is { } inUse && !JsonNode.DeepEquals(obj[field.Name], was?[field.Name]))
                        foreach (var idle in Idle(inUse, obj[field.Name], field)) obj.Remove(idle);
                    if (obj.TryGetPropertyValue(field.Name, out var child))
                        Cascade(child, DocumentNodes.VariantFor(field, obj), was?[field.Name]);
                }
                break;
            case JsonArray array when meta.ElementType is { } elementMeta:
                var held = current as JsonArray;
                for (var i = 0; i < array.Count; i++)
                    Cascade(array[i], elementMeta, held != null && i < held.Count ? held[i] : null);
                break;
        }
    }

    // Every slot the table governs is idle unless the value puts it in use.
    private static IEnumerable<string> Idle(IReadOnlyDictionary<string, IReadOnlyList<string>> table, JsonNode? value, FieldMetadata field) =>
        table.Values.SelectMany(v => v).Distinct(StringComparer.Ordinal).Except(InUse(table, value, field), StringComparer.Ordinal);

    // The siblings a governing member's value puts in use; an absent member reads as its declared default.
    private static IEnumerable<string> InUse(IReadOnlyDictionary<string, IReadOnlyList<string>> table, JsonNode? value, FieldMetadata field)
    {
        var name = value is JsonValue v && v.TryGetValue<string>(out var s) ? s : field.Default as string;
        return name != null && table.TryGetValue(name, out var siblings) ? siblings : [];
    }

    // The incoming leaf keeps every member it shapes alike; the outgoing leaf's own members, and any
    // shaped differently, are removed so the codec builds the new leaf from what it can hold. The
    // discriminator leads, as the codec requires.
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

    // Alike means the codec would take the same value under either leaf: same kind, same class and
    // — since each leaf closes an enum over its own members — the same domain, element included.
    private static bool SameShape(FieldMetadata? a, FieldMetadata? b) =>
        a is null || b is null
            ? a is null && b is null
            : a.Type == b.Type && a.LeafTypeName == b.LeafTypeName
              && a.EnumMembers.Select(m => m.Value).SequenceEqual(b.EnumMembers.Select(m => m.Value), StringComparer.Ordinal)
              && a.ValidFormKeyTypes.SequenceEqual(b.ValidFormKeyTypes, StringComparer.Ordinal)
              && SameShape(a.ElementType, b.ElementType);

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
        Cascade(element, elementMeta, null);
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
        var array = cursor.OwnerArray!;
        array.RemoveAt(cursor.Index);
        edited = array;
        editedMeta = ArrayMeta(cursor);
        return null;
    }

    private static RecordEditResult? Move(Cursor cursor, JsonElement? value, string spelled, out JsonNode? edited, out FieldMetadata editedMeta)
    {
        edited = null;
        editedMeta = cursor.Meta;
        var array = cursor.OwnerArray!;
        var destination = value!.Value.GetInt32();
        if (destination < 0 || destination >= array.Count) return NoElement($"{Owner(spelled)}[{destination}]", array.Count);
        if (destination == cursor.Index) return Malformed(spelled, $"the element is already at position {destination}");
        var node = array[cursor.Index];
        array.RemoveAt(cursor.Index);
        array.Insert(destination, node);
        edited = array;
        editedMeta = ArrayMeta(cursor);
        return null;
    }

    // The array's own spelling, which is the element's without its last hop.
    private static string Owner(string spelledElement) => spelledElement[..spelledElement.LastIndexOf('[')];

    // The array an element cursor sits in has the element's shape as its ElementType; its own key
    // members are what the comparison needs, so the array's metadata is rebuilt around the element's.
    private static FieldMetadata ArrayMeta(Cursor cursor) =>
        new("", "array", true, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, ElementType: cursor.Meta);

    // ── the closed pre-check list ───────────────────────────────────────────

    // Discriminator first on a union element, a member a known-defect row marks read-only, hex
    // length where the document establishes one; walked over the value with the metadata beside it.
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
                    // A whole-subtree set reaches a read-only member the same way a path to it does.
                    if (field.ReadOnlyReason is { } reason) return ReadOnlyRefusal($"{path}.{name}", name, reason);
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
        if (bit.FlagName == null)
        {
            var raw = owner[member] is JsonValue held && held.TryGetValue<long>(out var flags) ? flags : 0;
            var next = set ? raw | bit.Bit : raw & ~bit.Bit;
            if (next == 0) owner.Remove(member); else owner[member] = next;
            foreach (var alias in bit.Aliases) owner.Remove(alias);
        }
        else
        {
            var names = (owner[member] as JsonArray)?.Select(n => n!.GetValue<string>()).Where(n => n != bit.FlagName).ToList() ?? [];
            if (set) names.Add(bit.FlagName!);
            if (names.Count == 0) owner.Remove(member); else owner[member] = new JsonArray([.. names.Select(n => (JsonNode)n)]);
        }
        edited = owner;
        return null;
    }

    // ── walking ─────────────────────────────────────────────────────────────

    private static JsonObject WalkPrefix(JsonObject root, IReadOnlyList<PathHop> prefix) =>
        EmbeddedChildPath.Walk(root, prefix) as JsonObject
            ?? throw new InvalidOperationException($"The document has no object at {RecordEditEnvelope.Spell(prefix)}.");

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
