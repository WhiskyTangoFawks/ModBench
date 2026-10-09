using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Schema;

/// <summary>An edit by path on a copy of a record's document (ADR-0005): located against the schema,
/// then applied once.</summary>
public sealed class DocumentEdit
{
    private readonly JsonObject _record;
    private readonly EditOp _op;
    private readonly string _spelled;
    private readonly Cursor _cursor;
    private bool _applied;

    private DocumentEdit(JsonObject record, EditOp op, string spelled, Cursor cursor, ReadOnlyMember? readOnlyTarget) =>
        (_record, _op, _spelled, _cursor, ReadOnlyTarget) = (record, op, spelled, cursor, readOnlyTarget);

    /// <summary>The column the path starts at.</summary>
    public ColumnSpec Column => _cursor.Column;

    /// <summary>The member the path lands on, where the schema reads it as read-only. A read-only member's
    /// reason reaches every member below it (FieldMetadata.WithReadOnlyReason).</summary>
    public ReadOnlyMember? ReadOnlyTarget { get; }

    /// <summary>Whether the path lands on an element of an array whose elements are keyed.</summary>
    public bool InKeyedArray => _cursor.OwnerArray != null && _cursor.OwnerMeta?.KeyMembers != null;

    /// <summary>The element's position, where the path lands on an element.</summary>
    public int Position => _cursor.Index;

    /// <summary>Where <paramref name="path"/> lands in <paramref name="record"/>. A set or an add makes
    /// the objects on the way that the document omits.</summary>
    public static EditFailure? Locate(
        Document record, RecordTableSchema schema, EditOp op, IReadOnlyList<DocumentHop> path, out DocumentEdit? edit)
    {
        edit = null;
        var tree = record.Tree();
        if (Resolve(tree, schema, path, op is EditOp.Set or EditOp.Add, out var resolved) is { } unresolved) return unresolved;
        var cursor = resolved ?? throw new InvalidOperationException("Expected Resolve to set a cursor when it does not refuse.");
        var spelled = DocumentHop.Spell(path);
        var readOnly = cursor.Field?.ReadOnlyReason is { } why ? new ReadOnlyMember(spelled, cursor.MemberName ?? cursor.Column.Name, why) : null;
        edit = new(tree, op, spelled, cursor, readOnly);
        return null;
    }

    /// <summary>The first read-only member <paramref name="value"/> spells, unless a value
    /// <see cref="Apply"/> refuses comes before it.</summary>
    public ReadOnlyMember? ReadOnlyReached(string? value)
    {
        if (_cursor.Column.Synthetic != null) return null;
        var reached = _op switch
        {
            EditOp.Set when value is not null && JsonNode.Parse(value) is { } node =>
                PreCheck(node, _cursor.Meta, _cursor.Node, _spelled, readOnlyStops: true),
            EditOp.Add when _cursor.Meta.ElementType is { } elementMeta && _cursor.Node is null or JsonArray =>
                PreCheck(
                    (value is null ? null : JsonNode.Parse(value)) ?? LeafSpelling.Minted(elementMeta), elementMeta, null,
                    $"{_spelled}[{(_cursor.Node as JsonArray)?.Count ?? 0}]", readOnlyStops: true),
            _ => null,
        };
        return (reached as ReachesReadOnly)?.Member;
    }

    private sealed record ReachesReadOnly(ReadOnlyMember Member) : EditFailure(Member.Path);

    /// <summary>The edit made with <paramref name="value"/>, JSON text: what a set puts, what an add appends
    /// (null for the element's default), or a move's destination index.</summary>
    public EditFailure? Apply(string? value, out Patch? patch)
    {
        if (_applied) throw new InvalidOperationException("Expected an edit to be applied once.");
        _applied = true;
        patch = null;
        var failure = _cursor.Column.Synthetic is { } bit
            ? SetBit(bit, value, out var edited, out var editedMeta)
            : _op switch
            {
                EditOp.Set => Set(_cursor, value ?? throw new InvalidOperationException("Expected a set to carry a value."), _spelled, out edited, out editedMeta),
                EditOp.Add => Add(_cursor, value, _spelled, out edited, out editedMeta),
                EditOp.Remove => Remove(_cursor, out edited, out editedMeta),
                _ => Move(_cursor, value ?? throw new InvalidOperationException("Expected a move to carry its destination."), _spelled, out edited, out editedMeta),
            };
        if (failure is not null) return failure;
        var chain = IndexChain(edited ?? throw new InvalidOperationException("Expected the edit to set which node changed."));
        patch = new Patch(Document.Of(_record).WithoutAliasesOf(_cursor.Column), chain, editedMeta, _spelled);
        return null;
    }

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

        internal JsonArray RequireOwnerArray() =>
            OwnerArray ?? throw new InvalidOperationException("Expected this cursor to sit in an array, not an object.");

        internal string RequireMemberName() =>
            MemberName ?? throw new InvalidOperationException("Expected this cursor to name a member.");

        internal FieldMetadata RequireOwnerMeta() =>
            OwnerMeta ?? throw new InvalidOperationException("Expected this cursor to carry its owner's metadata.");

        internal FieldMetadata RequireField() =>
            Field ?? throw new InvalidOperationException("Expected this cursor to carry the field it resolved to.");
    }

    private static EditFailure? Resolve(
        JsonObject record, RecordTableSchema schema, IReadOnlyList<DocumentHop> path, bool creating, out Cursor? cursor)
    {
        cursor = null;
        var spelled = DocumentHop.Spell(path);
        var name = path[0].RequireMember();
        if (schema.RecordColumns.FirstOrDefault(c => c.Name == name) is not { } column)
            return new EditFailure.NoField(spelled, schema.TableName, name);
        if (column.Synthetic != null && path.Count > 1) return new EditFailure.NoMembers(spelled, name);

        var meta = column.Field;
        if (LeafOf(record) is { } recordLeaf && meta.Variants is { } byClass && !byClass.ContainsKey(recordLeaf))
            return new EditFailure.NoField(spelled, recordLeaf, name);

        var segments = column.PropertyName.Split('.');
        if (Document.OwnerAt(record, segments[..^1], creating) is not { } owner)
        {
            cursor = new Cursor { Column = column, Meta = meta };
            return null;
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
            var sofar = DocumentHop.Spell(path.Take(i + 1));
            var before = DocumentHop.Spell(path.Take(i));
            if (hop.Member is { } member)
            {
                if (cursor.Meta.Fields is not { } fields) return new EditFailure.NoMembers(sofar, before);
                if (cursor.Node is not JsonObject obj)
                {
                    if (cursor.Node != null || !creating) return new EditFailure.Absent(sofar, before);
                    obj = new JsonObject();
                    Attach(cursor, obj);
                }
                var field = fields.FirstOrDefault(f => f.Name == member);
                if (field == null) return new EditFailure.NoMember(sofar, cursor.Meta.LeafTypeName ?? before, member);
                if (LeafOf(obj) is { } leaf && field.Variants is { } variants && !variants.ContainsKey(leaf))
                    return new EditFailure.NoMember(sofar, leaf, member);

                cursor = new Cursor
                {
                    Column = column,
                    Node = obj[member],
                    Meta = DocumentNodes.VariantFor(field, obj),
                    Field = field,
                    OwnerObject = obj,
                    OwnerMeta = cursor.Meta,
                    MemberName = member,
                };
                continue;
            }

            if (cursor.Meta.ElementType is not { } elementMeta) return new EditFailure.NotAnArray(sofar, before, InTheDocument: false);
            if (cursor.Node is not JsonArray array)
            {
                if (cursor.Node != null) return new EditFailure.NotAnArray(sofar, before, InTheDocument: true);
                array = new JsonArray();
                if (creating) Attach(cursor, array);
            }
            var index = hop.RequireIndex();
            // An element that is not there is a path the document does not know, on every operation:
            // a stale panel must never hear that a write which did nothing landed.
            if (index >= array.Count) return new EditFailure.NoElement(sofar, array.Count);
            cursor = new Cursor
            {
                Column = column,
                Node = array[index],
                Meta = elementMeta,
                Field = elementMeta,
                OwnerArray = array,
                OwnerMeta = cursor.Meta,
                Index = index,
            };
        }

        return null;
    }

    private static void Attach(Cursor cursor, JsonNode node)
    {
        if (cursor.OwnerObject != null) cursor.OwnerObject[cursor.RequireMemberName()] = node;
        else cursor.RequireOwnerArray()[cursor.Index] = node;
        cursor.Node = node;
    }

    private static string? LeafOf(JsonObject? obj) =>
        obj?[LoquiUnions.UnionTypeDiscriminator] is JsonValue value && value.TryGetValue<string>(out var leaf) ? leaf : null;

    private static FieldMetadata RootMetadata(RecordTableSchema schema) =>
        new("", "struct", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            Fields: [.. schema.RecordColumns.Where(c => c.Synthetic == null).Select(c => c.Field)]);

    // ── the operations ──────────────────────────────────────────────────────

    private static EditFailure? Set(
        Cursor cursor, string value, string spelled,
        out JsonNode? edited, out FieldMetadata editedMeta)
    {
        edited = null;
        editedMeta = cursor.Meta;
        var node = JsonNode.Parse(value);
        if (node is null && cursor.OwnerArray != null) return new EditFailure.NullElement(spelled);

        if (PreCheck(node, cursor.Meta, cursor.Node, spelled, readOnlyStops: false) is { } refused) return refused;
        node = LeafSpelling.AsRead(node, cursor.Meta);
        Cascade(node, cursor.Meta, cursor.Node);

        if (cursor.OwnerArray != null)
        {
            cursor.OwnerArray[cursor.Index] = node;
            // An element is never cleared with null (refused above), so parsing its value succeeded.
            edited = node ?? throw new InvalidOperationException("Expected a non-null element value.");
            return null;
        }

        var owner = cursor.OwnerObject ?? throw new InvalidOperationException("Expected this cursor to sit in an object, not an array.");
        var field = cursor.RequireField();
        var memberName = cursor.RequireMemberName();
        if (field.IsDiscriminator)
        {
            if (node is not JsonValue leafValue || !leafValue.TryGetValue<string>(out var leaf) || !field.EnumMembers.Any(m => m.Value == leaf))
                return new EditFailure.NotALeaf(spelled, field);
            SwitchLeaf(owner, cursor.RequireOwnerMeta(), LeafOf(owner), leaf);
            edited = owner;
            editedMeta = cursor.RequireOwnerMeta();
            return null;
        }

        if (field.SiblingsInUse is { } inUse)
        {
            // A stale slot posted under an earlier value is cleared here, never carried.
            foreach (var idle in Idle(inUse, node, field)) owner.Remove(idle);
            if (node == null) owner.Remove(memberName); else owner[memberName] = node;
            edited = owner;
            editedMeta = cursor.RequireOwnerMeta();
            return null;
        }

        if (node == null)
        {
            owner.Remove(memberName);
            edited = owner;
            editedMeta = cursor.RequireOwnerMeta();
            return null;
        }
        owner[memberName] = node;
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
        var fields = ownerMeta.Fields
            ?? throw new InvalidOperationException($"Expected '{ownerMeta.LeafTypeName ?? ownerMeta.Name}' to declare its own fields.");
        foreach (var member in fields)
        {
            if (member.Variants is not { } variants || !owner.ContainsKey(member.Name)) continue;
            var kept = variants.TryGetValue(to, out var incoming)
                && (from == null || !variants.TryGetValue(from, out var outgoing) || SameShape(incoming, outgoing));
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

    private static EditFailure? Add(
        Cursor cursor, string? value, string spelled,
        out JsonNode? edited, out FieldMetadata editedMeta)
    {
        edited = null;
        editedMeta = cursor.Meta;
        if (cursor.Meta.ElementType is not { } elementMeta) return new EditFailure.NoArrayToAppendTo(spelled);
        if (cursor.Node is not JsonArray array)
        {
            if (cursor.Node != null) return new EditFailure.NotAnArray(spelled, spelled, InTheDocument: true);
            array = new JsonArray();
            Attach(cursor, array);
        }

        var element = (value is null ? null : JsonNode.Parse(value)) ?? LeafSpelling.Minted(elementMeta);
        if (PreCheck(element, elementMeta, null, $"{spelled}[{array.Count}]", readOnlyStops: false) is { } refused) return refused;
        element = LeafSpelling.AsRead(element, elementMeta);
        Cascade(element, elementMeta, null);
        array.Add(element);
        edited = array;
        return null;
    }

    private static EditFailure? Remove(Cursor cursor, out JsonNode? edited, out FieldMetadata editedMeta)
    {
        var array = cursor.RequireOwnerArray();
        array.RemoveAt(cursor.Index);
        edited = array;
        editedMeta = cursor.RequireOwnerMeta();
        return null;
    }

    private static EditFailure.NoElement? Move(Cursor cursor, string value, string spelled, out JsonNode? edited, out FieldMetadata editedMeta)
    {
        edited = null;
        editedMeta = cursor.Meta;
        var array = cursor.RequireOwnerArray();
        var destination = JsonElement.Parse(value).GetInt32();
        if (destination < 0 || destination >= array.Count) return new EditFailure.NoElement($"{Owner(spelled)}[{destination}]", array.Count);
        var node = array[cursor.Index];
        array.RemoveAt(cursor.Index);
        array.Insert(destination, node);
        edited = array;
        editedMeta = cursor.RequireOwnerMeta();
        return null;
    }

    // The array's own spelling, which is the element's without its last hop.
    private static string Owner(string spelledElement) => spelledElement[..spelledElement.LastIndexOf('[')];

    // ── the closed pre-check list ───────────────────────────────────────────

    // Discriminator first on a union element, hex length where the document establishes one, no alpha
    // where a colour holds none. A read-only member stops the walk only when asked: Commands refuses it.
    private static EditFailure? PreCheck(JsonNode? value, FieldMetadata meta, JsonNode? current, string path, bool readOnlyStops)
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
                        return new EditFailure.NotALeaf(path, discriminator);
                    }
                }
                var currentObj = current as JsonObject;
                foreach (var (name, child) in obj)
                {
                    if (fields.FirstOrDefault(f => f.Name == name) is not { } field) continue;
                    // A whole-subtree set reaches a read-only member the same way a path to it does.
                    if (field.ReadOnlyReason is { } reason)
                    {
                        if (readOnlyStops) return new ReachesReadOnly(new ReadOnlyMember($"{path}.{name}", name, reason));
                        continue;
                    }
                    if (PreCheck(child, DocumentNodes.VariantFor(field, obj), currentObj?[name], $"{path}.{name}", readOnlyStops) is { } refused) return refused;
                }
                return null;
            case JsonArray array when meta.ElementType is { } elementMeta:
                var currentArray = current as JsonArray;
                for (var i = 0; i < array.Count; i++)
                {
                    if (PreCheck(array[i], elementMeta, currentArray != null && i < currentArray.Count ? currentArray[i] : null, $"{path}[{i}]", readOnlyStops) is { } refused)
                        return refused;
                }
                return null;
            case JsonValue text when meta.Type == ByteSliceHex.HexApiType:
                if (current is JsonValue held && held.TryGetValue<string>(out var heldHex) && ByteSliceHex.TryParseHex(heldHex, out var heldBytes)
                    && heldBytes.Length > 0 && text.TryGetValue<string>(out var newHex) && ByteSliceHex.TryParseHex(newHex, out var newBytes)
                    && newBytes.Length != heldBytes.Length)
                {
                    return new EditFailure.HexResize(path, heldBytes.Length, newBytes.Length);
                }
                return null;
            case JsonValue text when meta.Type == ColorReading.ApiType && !meta.HoldsAlpha:
                return text.TryGetValue<string>(out var color) && ColorReading.SpellsAlpha(color) ? new EditFailure.AlphaGiven(path, color) : null;
            default:
                return null;
        }
    }

    // ── synthetic members ───────────────────────────────────────────────────

    private EditFailure.NotABoolean? SetBit(SyntheticBit bit, string? value, out JsonNode? edited, out FieldMetadata editedMeta)
    {
        edited = null;
        editedMeta = new("", "struct", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers);
        if (_op != EditOp.Set || value is null || JsonElement.Parse(value) is not { ValueKind: JsonValueKind.True or JsonValueKind.False } given)
            return new EditFailure.NotABoolean(_spelled);
        var set = given.GetBoolean();

        var segments = bit.BackingPath.Split('.');
        var owner = Document.OwnerOf(_record, segments[..^1]);
        var member = segments[^1];
        var names = (owner[member] as JsonArray)?
            .Select(n => (n ?? throw new InvalidOperationException("Expected every flag-array element to be a non-null string."))
                .GetValue<string>())
            .Where(n => n != bit.FlagName).ToList() ?? [];
        if (set) names.Add(bit.FlagName);
        if (names.Count == 0) owner.Remove(member); else owner[member] = new JsonArray([.. names.Select(n => (JsonNode)n)]);
        edited = owner;
        return null;
    }

    // ── walking ─────────────────────────────────────────────────────────────

    // The node's place from the root, by member name and by position, so the same chain addresses
    // it in what the codec wrote back.
    private static List<object> IndexChain(JsonNode node)
    {
        var chain = new List<object>();
        for (var current = node; current.Parent != null; current = current.Parent)
            chain.Insert(0, current.Parent is JsonArray ? current.GetElementIndex() : current.GetPropertyName());
        return chain;
    }

    /// <summary>The document an edit leaves, and the node it changed.</summary>
    public sealed class Patch
    {
        private readonly List<object> _chain;
        private readonly FieldMetadata _meta;
        private readonly string _spelled;

        internal Patch(Document document, List<object> chain, FieldMetadata meta, string spelled) =>
            (Document, _chain, _meta, _spelled) = (document, chain, meta, spelled);

        public Document Document { get; }

        /// <summary>The first member the patch spelled that <paramref name="written"/>, the codec's text of
        /// <paramref name="patched"/>, did not keep, unless a default the codec omits; null when it kept
        /// them all.</summary>
        public string? FirstDropped(Document patched, Document written) =>
            SilentSkipGuard.Keeps(At(written.Tree(), _chain), At(patched.Tree(), _chain), _meta, _spelled, out var dropped) ? null : dropped;

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
}
