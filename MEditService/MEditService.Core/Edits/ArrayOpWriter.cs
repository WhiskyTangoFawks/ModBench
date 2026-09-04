using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>Computes the array ops (remove, move, add) server-side and hands the whole rebuilt value
/// to <see cref="ColumnSpec.Apply"/>, so every existing write-path guarantee applies unchanged: this
/// class decides what is written, never how.</summary>
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

        // Only array- or struct-shaped columns arrive here; a scalar column's Extract is a raw CLR value,
        // not JSON text, and would reach JsonNode.Parse as an unparseable string.
        if (!col.IsArray && col.SubFields == null) return FieldApplyOutcome.ValueShapeMismatch;

        // An unpopulated column extracts as null, not an empty shape (Mutagen distinguishes the two), so
        // root is seeded with the container its first hop needs and ResolveOrCreate always has a node
        // to attach onto.
        var currentJson = col.Extract(record) as string;
        JsonNode root;
        if (currentJson != null) root = JsonNode.Parse(currentJson)!;
        else if (arrayPath.Count > 0 && arrayPath[0] is MemberSegment) root = new JsonObject();
        else root = new JsonArray();

        // The walk carries the schema with the value: a key hop reads the array's declared key members,
        // never the envelope's, and a key hop into an unkeyed array is refused.
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
        // The reconstructed value goes through the same keyed-array normalization a hand-authored payload
        // does, so a second element added before the first was keyed collides with it.
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

    // A key no element carries resolves to -1, which every mutation reads as "nothing to do", the
    // same as an out-of-range index.
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

    // The key is read against the array's own declared key members, never the envelope's; the
    // envelope carries them only for the webview, which has no schema in scope.
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

    // An absent or null hop is "nothing yet", never a shape mismatch: remove/move answer NoOp, add
    // starts a fresh list. Synthesized containers attach to their parent as created, or they vanish
    // when root is re-serialized.

    // The schema travels with the value because a key hop needs both at the same depth.
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

    // One hop of the walk: synthesizes a struct member nothing populated yet, but never an absent array
    // element. Null where the hop names a shape that isn't there.
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

    // 'formKey' defaults to "Null", Mutagen's wire sentinel for an unset FormLink, rather than "":
    // FormKey.TryFactory has no case for the empty string, so a bare-FormLink-array Add sending it
    // would silently add nothing.

    // "struct" names only the discriminator: BuildListElement constructs a fresh instance, so an
    // unnamed member keeps its CLR default, and naming a read-only nested struct or an enum whose
    // wire shape FieldMetadata cannot predict would refuse the write.
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

    // A discriminator is the one member a default struct element names, starting as the schema's first
    // leaf (docs/specs/medit-record-editor.md, "A new array element's default is the backend's").
    private static JsonObject DefaultStructElement(FieldMetadata meta)
    {
        var element = new JsonObject();
        // A union with no leaf is not reflected as one at all (LoquiUnions.TryGetUnion requires one), so
        // the count guard keeps the indexer total rather than handling a case that can arrive.
        foreach (var field in meta.Fields ?? [])
            if (field.IsDiscriminator && field.EnumMembers.Count > 0) element[field.Name] = field.EnumMembers[0].Value;
        return element;
    }

    // A read-only nested struct member round-trips as an explicit JSON null, and a named member is
    // targeting regardless of value, so un-stripped every array op on such an array would refuse.

    // Safe only because this tree is the field's own current value, never a caller-supplied payload:
    // nothing here ever wrote a null, so there is no edit to lose.
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
