using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>
/// #630: the four array arity/order op envelopes — <c>array_remove</c>/<c>array_move_up</c>/
/// <c>array_move_down</c>/<c>array_add</c> — computed here instead of round-tripped as a
/// client-computed whole array through the webview. Scope is ordinary reflected fields only
/// (<see cref="ColumnSpec"/>-backed columns), which includes a script's properties and a Papyrus
/// scalar-array property's elements.
///
/// <para>Each op reads the column's own <i>current</i> value (<see cref="ColumnSpec.Extract"/>),
/// walks the envelope's own <c>path</c> to the target array — an ordinary reflected field's wire
/// <c>fieldPath</c> never encodes nesting, only the value tree does, the same convention
/// <c>RecordPanel.tsx</c>'s own (now-deleted) client-side <c>handleArrayOp</c> used — mutates a JSON
/// copy, and hands the whole reconstructed value to the exact same <see cref="ColumnSpec.Apply"/>
/// every ordinary complex-field write already goes through. That reuse is deliberate: every existing
/// write-path guarantee (#642's <c>NestedFieldReadOnly</c> included) applies unchanged, because this
/// class only computes <i>what</i> gets written, never how.</para>
/// </summary>
internal static class ArrayOpWriter
{
    private static readonly HashSet<string> OpNames =
        ["array_remove", "array_move_up", "array_move_down", "array_add"];

    internal static bool IsArrayOp(string opName) => OpNames.Contains(opName);

    internal static FieldApplyResult Apply(
        IMajorRecord record, ColumnSpec col, string opName, JsonElement envelope)
    {
        if (col.Apply.Writer is not { } apply) return FieldApplyOutcome.ReadOnly;
        if (!envelope.TryGetProperty("path", out var pathEl) || pathEl.ValueKind != JsonValueKind.Array)
            return FieldApplyOutcome.ValueShapeMismatch;

        var path = ParsePath(pathEl);
        if (path == null) return FieldApplyOutcome.ValueShapeMismatch;

        // 'array_add' addresses the array itself; every other op addresses one of its elements, so
        // the array is one hop shorter than the envelope's own path (the last hop names the
        // element, by position or by key).
        var isAdd = opName == "array_add";
        var arrayPath = isAdd ? path : path[..Math.Max(path.Count - 1, 0)];
        if (!isAdd && path.Count == 0) return FieldApplyOutcome.ValueShapeMismatch;

        // An array op only ever targets a column that is itself array-shaped (a bare top-level
        // array) or struct-shaped (an array nested one or more hops inside it) — never a genuinely
        // scalar column, whose own Extract is the raw CLR value (not JSON text) and would otherwise
        // reach JsonNode.Parse below as an unparseable string.
        if (!col.IsArray && col.SubFields == null) return FieldApplyOutcome.ValueShapeMismatch;

        // A never-populated column's own Extract answers null, not the empty shape it would
        // otherwise hold — Mutagen distinguishes "no list/struct at all" from "an empty/default one"
        // at the property level even though both mean the same thing to an array op (there is
        // nothing to remove/move from either, and Add starts a list from nothing the same way it
        // appends to an existing empty one). `root` is seeded with the container shape its own
        // first hop needs (object for a 'member' hop, array otherwise/none) so ResolveOrCreate below
        // always has a real, attachable node to build the rest of the path onto — never null itself.
        var currentJson = col.Extract(record) as string;
        JsonNode root;
        if (currentJson != null) root = JsonNode.Parse(currentJson)!;
        else if (arrayPath.Count > 0 && arrayPath[0] is MemberSegment) root = new JsonObject();
        else root = new JsonArray();

        // The walk carries the schema alongside the value, so a hop's meaning comes from the
        // record's own metadata rather than from the envelope: a key hop's key members are the
        // array's declared ones, and a key hop into an array the schema does not key is refused.
        var (array, arrayMeta) = ResolveOrCreate(root, arrayPath, col.ToFieldMetadata());
        if (array == null) return FieldApplyOutcome.ValueShapeMismatch;

        // The element hop is resolved against the array it was just walked to, never before it: a
        // key names an element, and where that element sits is a fact about this record's own array.
        var index = isAdd ? 0 : path[^1].IndexIn(array, arrayMeta);
        if (index == null) return FieldApplyOutcome.ValueShapeMismatch;

        var changed = opName switch
        {
            "array_remove" => TryRemove(array, index.Value),
            "array_move_up" => TryMove(array, index.Value, -1),
            "array_move_down" => TryMove(array, index.Value, 1),
            "array_add" => TryAppend(array, arrayMeta?.ElementType),
            _ => false,
        };
        if (!changed) return FieldApplyOutcome.NoOp;

        StripNulls(root);
        // The reconstructed value goes through the same keyed-array normalization a hand-authored
        // payload does (RecordFieldWriter.TryApply): an element appended to a keyed array lands in
        // key order, and a second element added before the first one was given a key collides with it.
        var newValue = KeyedArrays.Normalize(
            JsonSerializer.SerializeToElement(root), col.ToFieldMetadata(), out var duplicateKey);
        if (duplicateKey != null) return new(FieldApplyOutcome.DuplicateKeyInKeyedArray, duplicateKey);

        return apply(record, newValue) switch
        {
            ApplyOutcome.Applied => FieldApplyOutcome.Applied,
            ApplyOutcome.PropertyNotFound => FieldApplyOutcome.NotFound,
            ApplyOutcome.ListElementTypeUnresolved => FieldApplyOutcome.ListElementTypeUnresolved,
            ApplyOutcome.SubFieldReadOnly => FieldApplyOutcome.NestedFieldReadOnly,
            _ => FieldApplyOutcome.ValueShapeMismatch,
        };
    }

    // ── path segments ("member"/"index"/"key" — a pure-FormLink array offers no array op at all,
    // so no "sortKey" hop reaches here; see recordUtils.ts's own PathSegment doc comment) ─────────

    /// <summary>Where this hop's element sits in the array it is resolved against, or null when the
    /// hop names no element there at all: a member hop, or a key hop into an array the schema does
    /// not key. A key no element in that array carries answers -1, which every mutation below reads
    /// as "nothing to do" the same way an out-of-range index does.</summary>
    private interface IPathSegment
    {
        int? IndexIn(JsonArray array, FieldMetadata? arrayMeta);
    }

    private sealed record MemberSegment(string Name) : IPathSegment
    {
        public int? IndexIn(JsonArray array, FieldMetadata? arrayMeta) => null;
    }

    private sealed record IndexSegment(int Index) : IPathSegment
    {
        public int? IndexIn(JsonArray array, FieldMetadata? arrayMeta) => Index;
    }

    /// <summary>A keyed array's element, named by its key. The key members that key is read against
    /// are the array's own declared ones, never the envelope's — the envelope carries them for the
    /// webview's sake (recordUtils.ts resolves the same hop with no schema in scope) and this side
    /// reads its own schema.</summary>
    private sealed record KeySegment(string Key) : IPathSegment
    {
        public int? IndexIn(JsonArray array, FieldMetadata? arrayMeta) =>
            arrayMeta?.KeyMembers is { } members ? IndexOf(array, members) : null;

        private int IndexOf(JsonArray array, IReadOnlyList<string> members)
        {
            for (var i = 0; i < array.Count; i++)
            {
                if (string.Equals(ElementKey.Of(array[i], members).Text, Key, StringComparison.Ordinal)) return i;
            }
            return -1;
        }
    }

    private static List<IPathSegment>? ParsePath(JsonElement pathEl)
    {
        var result = new List<IPathSegment>();
        foreach (var seg in pathEl.EnumerateArray())
        {
            if (!seg.TryGetProperty("kind", out var kindEl) || kindEl.ValueKind != JsonValueKind.String)
                return null;
            var kind = kindEl.GetString()!;
            if (kind == "member" && seg.TryGetProperty("name", out var nameEl) && nameEl.ValueKind == JsonValueKind.String)
                result.Add(new MemberSegment(nameEl.GetString()!));
            else if (kind == "index" && seg.TryGetProperty("index", out var idxEl) && idxEl.ValueKind == JsonValueKind.Number)
                result.Add(new IndexSegment(idxEl.GetInt32()));
            else if (kind == "key" && seg.TryGetProperty("key", out var keyEl) && keyEl.ValueKind == JsonValueKind.String)
                result.Add(new KeySegment(keyEl.GetString()!));
            else
                return null;
        }
        return result;
    }

    // Walks `path` from `node` down to the target array and its schema together, treating an absent
    // (or explicitly null) hop at any depth as "nothing here yet" rather than a shape mismatch: a
    // struct member, or a struct-nested array, that was never populated defaults to an empty
    // container the same way an unset top-level array column does, so remove/move correctly answer
    // NoOp against it (nothing to remove/move from a freshly-built empty array either) and add
    // correctly starts a fresh list. Every synthesized container is attached back onto its own
    // parent as it's created — a value built but never attached would vanish the moment `root` is
    // re-serialized, which a node returned in isolation (e.g. `new JsonArray()`, unattached) cannot
    // guarantee. `root` itself is never null (the caller seeds it to match the first hop before
    // calling this), so there is always somewhere real to attach into. A hop that *is* present but
    // of the wrong shape (an element hop into an object, a member hop into an array, or a final
    // value that is neither an array nor an absence) is a genuine mismatch and answers a null array.
    //
    // The schema travels alongside the value rather than in a pass of its own, because the key hop
    // needs both at the same depth: which element a key names is read off the value, and which
    // members that key is are read off the schema.
    private static (JsonArray? Array, FieldMetadata? Meta) ResolveOrCreate(
        JsonNode root, IReadOnlyList<IPathSegment> path, FieldMetadata? rootMeta)
    {
        JsonNode? current = root;
        var meta = rootMeta;
        for (var i = 0; i < path.Count; i++)
        {
            // What the *next* hop (or the final array target, if this is the last one) needs this
            // position to be — an object if the next hop reads a member off it, an array otherwise.
            JsonNode NextContainer() =>
                i + 1 < path.Count && path[i + 1] is MemberSegment ? new JsonObject() : new JsonArray();

            current = StepInto(current, path[i], meta, NextContainer);
            if (current == null) return (null, null);
            meta = path[i] is MemberSegment member
                ? meta?.Fields?.FirstOrDefault(f => f.Name == member.Name)
                : meta?.ElementType;
        }
        return (current as JsonArray, meta);
    }

    // One hop of the walk above: the child this segment names, synthesized and attached when the hop
    // is a struct member nothing has populated yet. Null where the hop names a shape that isn't
    // there — an element hop into an object, a member hop into an array, or an element no array here
    // answers to (an absent array *element* is never synthesized, only a struct member or a nested
    // array/struct value is).
    private static JsonNode? StepInto(
        JsonNode? current, IPathSegment seg, FieldMetadata? meta, Func<JsonNode> nextContainer)
    {
        if (seg is MemberSegment member)
        {
            if (current is not JsonObject obj) return null;
            var child = obj.TryGetPropertyValue(member.Name, out var v) ? v : null;
            if (child == null) { child = nextContainer(); obj[member.Name] = child; }
            return child;
        }

        if (current is not JsonArray array || seg.IndexIn(array, meta) is not { } index
            || index < 0 || index >= array.Count)
        {
            return null;
        }

        var element = array[index];
        if (element == null) { element = nextContainer(); array[index] = element; }
        return element;
    }

    // ── mutation ─────────────────────────────────────────────────────────────

    private static bool TryRemove(JsonArray array, int index)
    {
        if (index < 0 || index >= array.Count) return false; // boundary no-op
        array.RemoveAt(index);
        return true;
    }

    private static bool TryMove(JsonArray array, int index, int direction)
    {
        var j = index + direction;
        if (index < 0 || index >= array.Count || j < 0 || j >= array.Count) return false; // boundary no-op
        var node = array[index];
        array.RemoveAt(index);
        array.Insert(j, node);
        return true;
    }

    private static bool TryAppend(JsonArray array, FieldMetadata? elementMeta)
    {
        array.Add(DefaultElementValue(elementMeta));
        return true; // never a no-op
    }

    // A struct element's own sub-fields are never individually defaulted here (see the "struct" arm
    // below). 'formKey'
    // defaults to the string "Null" (Mutagen's own wire sentinel for an explicitly-unset FormLink —
    // the same token its codec already round-trips, seen verbatim in ColumnSpec.Extract's own
    // output for a field nobody set) rather than "" — "" is not a parseable FormKey
    // (FormKey.TryFactory has no case for the empty string), so a bare-FormLink-array Add sending it
    // would silently add nothing at all (ListLeaves.BuildListElement's own isFl branch returns
    // null for an unparseable element, and its caller only adds non-null items).
    //
    // "struct" names nothing but the element's discriminator, if it has one: the write path itself
    // (BuildListElement's non-isFl branch) already constructs a fresh instance via
    // Activator.CreateInstance before applying anything, which hands every field its own CLR
    // default for free — an unnamed member is then skipped by ApplySubFields ("absence is not
    // targeting") and the freshly-constructed defaults stand untouched. This sidesteps two problems
    // a field-by-field default can't solve from FieldMetadata alone: a "struct"-typed member that
    // is actually a #642 read-only nested Loqui struct (naming it at all,
    // with any value, refuses the whole write) and a "enum" member whose wire shape FieldMetadata's
    // own IsBitmask doesn't reliably predict (ColumnSpec's own IsFlagsEnum, which does, isn't on
    // the wire type) — both are simply never named, and the constructed instance's own default is
    // already correct for either.
    //
    private static JsonNode? DefaultElementValue(FieldMetadata? meta) => meta?.Type switch
    {
        "string" => "",
        "formKey" => "Null",
        "int" or "float" => 0,
        "bool" => false,
        "enum" when meta.IsBitmask => new JsonArray(),
        "enum" => meta.EnumMembers.Count > 0 ? meta.EnumMembers[0].Value : "",
        "struct" => DefaultStructElement(meta),
        "array" => new JsonArray(),
        // Mutagen's own empty-slice token, which is what a byte-slice element's Extract emits for
        // one. Explicit rather than riding the catch-all "" below, which reads as an absent slice.
        "hex" => "[]",
        _ => "",
    };

    // A discriminator is the one member a default struct element names, and it starts as the first
    // leaf the schema lists (docs/specs/medit-record-editor.md, "A new array element's default is
    // the backend's"). An ordinary struct, having none, still defaults to the empty object.
    private static JsonObject DefaultStructElement(FieldMetadata meta)
    {
        var element = new JsonObject();
        // A discriminator's members are its union's leaves, and a union with no leaf is not
        // reflected as one at all (LoquiUnions.TryGetUnion requires at least one, and
        // OMOD's leaf table is a literal) — so the count guard is what keeps the indexer total,
        // not a case that can arrive.
        foreach (var field in meta.Fields ?? [])
            if (field.IsDiscriminator && field.EnumMembers.Count > 0) element[field.Name] = field.EnumMembers[0].Value;
        return element;
    }

    // The read-only nested-Loqui-struct member #642 introduced (StructLeaves.BuildStructSubField's
    // own read-only Apply with TargetingRefuses: true) is still *extracted* for display even though nothing
    // writes it — so an untouched element's own unset such member round-trips here as an explicit
    // JSON null, and ApplySubFields/ApplyListJson treat a *named* member as targeting it regardless
    // of value (absence is what "not targeting" means, never nullity — see ApplySubFields's own doc
    // comment). Left un-stripped, every array op on an array containing such an element would refuse
    // — even one that never touches that element — purely because the reconstruction happened to
    // name a key it never meant to write. Stripping every null-valued member before resubmission
    // restores "absence is not targeting" for the common (unset) case; a genuinely *non-null* nested
    // value still correctly refuses (ArrayOpEditTests pins both).
    //
    // This is a blunt tool in general — JSON null is meaningful elsewhere in this same write path
    // (MakeApplier/ApplySubFields: a null clears a nullable FormLink, and a non-nullable column
    // refuses one outright rather than treating it as absence) — but it is safe *here* specifically
    // because of where this JSON tree came from: `root` above is always the freshly-`Extract`ed
    // current value of the whole field, never a caller-supplied payload. Every null this strips is
    // therefore already exactly what the record's own persisted state holds for that member — there
    // is no edit to lose, because nothing here ever *wrote* a null; it only declined to re-name one
    // that was already there. A hand-authored payload naming a field explicitly as null (the general
    // case MakeApplier/ApplySubFields still have to honor) never reaches this function at all.
    private static void StripNulls(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var key in obj.Select(kv => kv.Key).ToList())
                {
                    if (obj[key] is null) obj.Remove(key);
                    else StripNulls(obj[key]);
                }
                break;
            case JsonArray arr:
                foreach (var item in arr) StripNulls(item);
                break;
        }
    }
}
