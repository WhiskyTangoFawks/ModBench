using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MEditService.Codec.Schema;

namespace MEditService.Commands.Edits;

/// <summary>Two elements of one keyed array sharing a key. Another tool can write such a pair, and
/// an edit beside it is refused nothing because of it (ADR-0003); an edit that makes one is.</summary>
internal static partial class DuplicateKeys
{
    /// <summary>A key the edit shares between two elements, and the array holding them, or null when
    /// it made no pair. <paramref name="started"/> is the element an add built empty.</summary>
    internal static (string Key, string Path)? MadeBy(JsonNode before, JsonNode after, FieldMetadata meta, JsonNode? started = null)
    {
        var arrays = KeyedArrays.Under(after, meta);
        var was = Surplus(KeyedArrays.Under(before, meta));
        var now = Surplus(arrays);
        var tolerated = DefaultHeldOnce(arrays, started, was);
        bool Grew((string Key, string Path) pair, Func<string, string> place) =>
            now.Count(p => p.Key == pair.Key && place(p.Path) == place(pair.Path))
            > was.Count(p => p.Key == pair.Key && place(p.Path) == place(pair.Path));

        // A remove or a move shifts the paths of the arrays inside the elements after it, so an
        // array is matched across the edit by its path without positions.
        foreach (var pair in now.Where(p => p != tolerated))
        {
            if (Grew(pair, path => path) && Grew(pair, path => Position().Replace(path, "[]"))) return pair;
        }
        return null;
    }

    // A key Mutagen cannot leave unset starts an added element at its default, which one element may
    // hold: the add has nowhere else to start (editor-fields.md, Arrays, story 3), so only a third
    // holder is refused (story 4).
    private static (string Key, string Path)? DefaultHeldOnce(List<KeyedArray> arrays, JsonNode? started, List<(string Key, string Path)> was)
    {
        if (started == null) return null;
        foreach (var array in arrays)
        {
            var index = array.Elements.IndexOf(started);
            if (index < 0) continue;
            var key = array.Keys[index];
            return key.IsUnset || was.Contains((key.Text, array.Path)) ? null : (key.Text, array.Path);
        }
        return null;
    }

    // One entry for each element beyond the first at its key.
    private static List<(string Key, string Path)> Surplus(List<KeyedArray> arrays) =>
        [.. arrays.SelectMany(array => array.Keys
            .GroupBy(key => key.Text, StringComparer.Ordinal)
            .SelectMany(sharing => sharing.Skip(1).Select(_ => (sharing.Key, array.Path))))];

    [GeneratedRegex(@"\[\d+\]")]
    private static partial Regex Position();
}
