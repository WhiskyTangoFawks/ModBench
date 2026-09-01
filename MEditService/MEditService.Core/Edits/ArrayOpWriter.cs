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
/// (<see cref="ColumnSpec"/>-backed columns) — a VMAD property's own array is a separate codec
/// surface (<c>VmadCodec</c>) with its own structural-op vocabulary and is deliberately not reached
/// from here; see <see cref="RecordFieldWriter"/>'s VMAD-path guard.
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

    internal static FieldApplyOutcome Apply(IMajorRecord record, ColumnSpec col, string opName, JsonElement envelope)
    {
        if (col.Apply == null) return FieldApplyOutcome.ReadOnly;
        if (!envelope.TryGetProperty("path", out var pathEl) || pathEl.ValueKind != JsonValueKind.Array)
            return FieldApplyOutcome.ValueShapeMismatch;

        var path = ParsePath(pathEl);
        if (path == null) return FieldApplyOutcome.ValueShapeMismatch;

        // 'array_add' addresses the array itself; every other op addresses one of its elements, so
        // the array is one hop shorter than the envelope's own path (the last hop is the element's
        // own index) — the same convention the deleted client-side handleArrayOp always used.
        var isAdd = opName == "array_add";
        var arrayPath = isAdd ? path : path[..Math.Max(path.Count - 1, 0)];
        var index = isAdd ? -1 : LastIndex(path);
        if (!isAdd && index == null) return FieldApplyOutcome.ValueShapeMismatch;

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
        else if (arrayPath.Count > 0 && arrayPath[0].Kind == "member") root = new JsonObject();
        else root = new JsonArray();

        if (ResolveOrCreate(root, arrayPath) is not { } array)
            return FieldApplyOutcome.ValueShapeMismatch;

        var changed = opName switch
        {
            "array_remove" => TryRemove(array, index!.Value),
            "array_move_up" => TryMove(array, index!.Value, -1),
            "array_move_down" => TryMove(array, index!.Value, 1),
            "array_add" => TryAppend(array, ResolveElementMeta(col, arrayPath)),
            _ => false,
        };
        if (!changed) return FieldApplyOutcome.NoOp;

        StripNulls(root);
        var newValue = JsonSerializer.SerializeToElement(root);
        return col.Apply(record, newValue) switch
        {
            ApplyOutcome.Applied => FieldApplyOutcome.Applied,
            ApplyOutcome.PropertyNotFound => FieldApplyOutcome.NotFound,
            ApplyOutcome.ListElementTypeUnresolved => FieldApplyOutcome.ListElementTypeUnresolved,
            ApplyOutcome.SubFieldReadOnly => FieldApplyOutcome.NestedFieldReadOnly,
            _ => FieldApplyOutcome.ValueShapeMismatch,
        };
    }

    // ── path segments ("member"/"index" only — array ops only ever reach an unsorted array, whose
    // rows never carry a "sortKey" hop; see recordUtils.ts's own PathSegment doc comment) ─────────

    private sealed record PathSegment(string Kind, string? Name, int? Index);

    private static List<PathSegment>? ParsePath(JsonElement pathEl)
    {
        var result = new List<PathSegment>();
        foreach (var seg in pathEl.EnumerateArray())
        {
            if (!seg.TryGetProperty("kind", out var kindEl) || kindEl.ValueKind != JsonValueKind.String)
                return null;
            var kind = kindEl.GetString()!;
            if (kind == "member" && seg.TryGetProperty("name", out var nameEl) && nameEl.ValueKind == JsonValueKind.String)
                result.Add(new PathSegment("member", nameEl.GetString(), null));
            else if (kind == "index" && seg.TryGetProperty("index", out var idxEl) && idxEl.ValueKind == JsonValueKind.Number)
                result.Add(new PathSegment("index", null, idxEl.GetInt32()));
            else
                return null;
        }
        return result;
    }

    private static int? LastIndex(IReadOnlyList<PathSegment> path) =>
        path.Count > 0 && path[^1] is { Kind: "index", Index: { } i } ? i : null;

    // Walks `path` from `node` down to the target array, treating an absent (or explicitly null)
    // hop at any depth as "nothing here yet" rather than a shape mismatch: a struct member, or a
    // struct-nested array, that was never populated defaults to an empty container the same way an
    // unset top-level array column does, so remove/move correctly answer NoOp against it (nothing to
    // remove/move from a freshly-built empty array either) and add correctly starts a fresh list.
    // Every synthesized container is attached back onto its own parent as it's created — a value
    // built but never attached would vanish the moment `root` is re-serialized, which a node
    // returned in isolation (e.g. `new JsonArray()`, unattached) cannot guarantee. `root` itself is
    // never null (the caller seeds it to match the first hop before calling this), so there is
    // always somewhere real to attach into. A hop that *is* present but of the wrong shape (an index
    // hop into an object, a member hop into an array, or a final value that is neither an array nor
    // an absence) is a genuine mismatch and returns null.
    private static JsonArray? ResolveOrCreate(JsonNode root, IReadOnlyList<PathSegment> path)
    {
        JsonNode current = root;
        for (var i = 0; i < path.Count; i++)
        {
            var seg = path[i];
            // What the *next* hop (or the final array target, if this is the last one) needs this
            // position to be — an object if the next hop reads a member off it, an array otherwise.
            JsonNode NextContainer() =>
                i + 1 < path.Count && path[i + 1].Kind == "member" ? new JsonObject() : new JsonArray();

            if (seg.Kind == "member")
            {
                if (current is not JsonObject obj) return null;
                var child = obj.TryGetPropertyValue(seg.Name!, out var v) ? v : null;
                if (child == null) { child = NextContainer(); obj[seg.Name!] = child; }
                current = child;
            }
            else if (seg.Kind == "index" && current is JsonArray arr && seg.Index is { } idx && idx >= 0 && idx < arr.Count)
            {
                var child = arr[idx];
                if (child == null) { child = NextContainer(); arr[idx] = child; }
                current = child;
            }
            else
            {
                return null; // hop doesn't match the shape actually there, or names an index that
                             // doesn't exist yet (an absent array *element* is never synthesized —
                             // only a struct member or a nested array/struct value is)
            }
        }
        return current as JsonArray;
    }

    // The array's own FieldMetadata (for 'array_add's default element) — walked the same two hops
    // (member -> .Fields, index -> .ElementType) recordUtils.ts's own metaAtPath always used,
    // starting from the column's own reflected metadata rather than the array's current *value*
    // (an empty array has no element to inspect, but still has an element schema).
    private static FieldMetadata? ResolveElementMeta(ColumnSpec col, IReadOnlyList<PathSegment> arrayPath)
    {
        FieldMetadata? cur = col.ToFieldMetadata();
        foreach (var seg in arrayPath)
        {
            if (cur == null) return null;
            cur = seg.Kind == "member" ? cur.Fields?.FirstOrDefault(f => f.Name == seg.Name) : cur.ElementType;
        }
        return cur?.ElementType;
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

    // Deliberately not a field-by-field port of recordUtils.ts's own defaultElementValue — a
    // struct element's own sub-fields are never individually defaulted here (see the "struct" arm
    // below); everything else keeps the same shape recordUtils.ts used, with one fix: 'formKey'
    // defaults to the string "Null" (Mutagen's own wire sentinel for an explicitly-unset FormLink —
    // the same token its codec already round-trips, seen verbatim in ColumnSpec.Extract's own
    // output for a field nobody set) rather than "" — "" is not a parseable FormKey
    // (FormKey.TryFactory has no case for the empty string), so a bare-FormLink-array Add sending it
    // would silently add nothing at all (SchemaReflector.BuildListElement's own isFl branch returns
    // null for an unparseable element, and its caller only adds non-null items).
    //
    // "struct" sends an *empty* object rather than one field-defaulted member at a time: the write
    // path itself (BuildListElement's non-isFl branch) already constructs a fresh instance via
    // Activator.CreateInstance before applying anything, which hands every field its own CLR
    // default for free — an empty object payload then names nothing, so ApplySubFields skips every
    // member ("absence is not targeting") and the freshly-constructed defaults stand untouched. This
    // sidesteps two problems a field-by-field default can't solve from FieldMetadata alone: a
    // "struct"-typed member that is actually a #642 read-only nested Loqui struct (naming it at all,
    // with any value, refuses the whole write) and a "enum" member whose wire shape FieldMetadata's
    // own IsBitmask flag doesn't reliably predict (ColumnSpec's own IsFlagsEnum, which does, isn't on
    // the wire type) — both are simply never named, and the constructed instance's own default is
    // already correct for either.
    //
    // No 'defaultValue' override and no 'vmadObject' case: both are adapter-only concepts the
    // VMAD/Condition tree adapters synthesize client-side (webview/src/types.ts's own doc comment),
    // never present on a real reflected column's wire FieldMetadata, which is the only kind this
    // class ever sees.
    private static JsonNode? DefaultElementValue(FieldMetadata? meta) => meta?.Type switch
    {
        "string" => "",
        "formKey" => "Null",
        "int" or "float" => 0,
        "bool" => false,
        "enum" when meta.IsBitmask => new JsonArray(),
        "enum" => meta.EnumValues.Count > 0 ? meta.EnumValues[0] : "",
        "struct" => new JsonObject(),
        "array" => new JsonArray(),
        _ => "",
    };

    // The read-only nested-Loqui-struct member #642 introduced (SchemaReflector.BuildStructSubField's
    // own Apply: null / TargetingRefuses: true) is still *extracted* for display even though nothing
    // writes it — so an untouched element's own unset such member round-trips here as an explicit
    // JSON null, and ApplySubFields/ApplyListJson treat a *named* member as targeting it regardless
    // of value (absence is what "not targeting" means, never nullity — see ApplySubFields's own doc
    // comment). Left un-stripped, every array op on an array containing such an element would refuse
    // — even one that never touches that element — purely because the reconstruction happened to
    // name a key it never meant to write. Stripping every null-valued member before resubmission
    // restores "absence is not targeting" for the common (unset) case; a genuinely *non-null* nested
    // value still correctly refuses (ArrayOpEditTests pins both).
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
