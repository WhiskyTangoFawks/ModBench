using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MEditService.Codec.Schema;

namespace MEditService.Commands.Edits;

/// <summary>Two elements of one keyed array sharing a key. Another tool can write such a pair, and
/// an edit beside it is refused nothing because of it (ADR-0003); an edit that makes one is.</summary>
internal static partial class DuplicateKeys
{
    /// <summary>A key the edit from <paramref name="before"/> to <paramref name="after"/> shares
    /// between two elements, and the array holding them, or null when it made no pair.</summary>
    internal static (string Key, string Path)? MadeBy(JsonNode before, JsonNode after, FieldMetadata meta)
    {
        var was = Surplus(before, meta);
        var now = Surplus(after, meta);
        bool Grew((string Key, string Path) pair, Func<string, string> place) =>
            now.Count(p => p.Key == pair.Key && place(p.Path) == place(pair.Path))
            > was.Count(p => p.Key == pair.Key && place(p.Path) == place(pair.Path));

        // A remove or a move shifts the paths of the arrays inside the elements after it, so an
        // array is matched across the edit by its path without positions.
        foreach (var pair in now)
        {
            if (Grew(pair, path => path) && Grew(pair, path => Position().Replace(path, "[]"))) return pair;
        }
        return null;
    }

    // One entry for each element beyond the first at its key.
    private static List<(string Key, string Path)> Surplus(JsonNode node, FieldMetadata meta) =>
        [.. KeyedArrays.Under(node, meta).SelectMany(array => array.Keys
            .GroupBy(key => key.Text, StringComparer.Ordinal)
            .SelectMany(sharing => sharing.Skip(1).Select(_ => (sharing.Key, array.Path))))];

    [GeneratedRegex(@"\[\d+\]")]
    private static partial Regex Position();
}
