using System.Collections;
using System.Collections.Concurrent;
using System.Globalization;
using System.Numerics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>Whether two documents mean the same: JSON values equal, spacing and key order aside.</summary>
public static class DocumentMeaning
{
    private const string Root = "the document";

    /// <summary>The path of the first member where <paramref name="held"/> differs in meaning from
    /// <paramref name="produced"/>, or null when they mean the same. Non-JSON differs at the whole document.</summary>
    public static string? FirstDifference(byte[] held, byte[] produced)
    {
        if (held.AsSpan().SequenceEqual(produced)) return null;
        try
        {
            using var written = JsonDocument.Parse(held);
            using var read = JsonDocument.Parse(produced);
            return FirstDifference(written.RootElement, read.RootElement);
        }
        catch (JsonException)
        {
            return Root;
        }
    }

    /// <summary>The same answer for a document of <paramref name="recordType"/>, where a list whose order the format
    /// decides means the same in any order.</summary>
    public static string? FirstDifference(byte[] held, byte[] produced, GameRelease gameRelease, string? recordType)
    {
        var inOrder = FirstDifference(held, produced);
        if (inOrder is null || recordType is null or PluginHeader.RecordType) return inOrder;
        if (ReadOrNull(held, gameRelease, recordType) is not { } read) return inOrder;
        using var written = JsonDocument.Parse(held);
        using var regenerated = JsonDocument.Parse(produced);
        return FirstDifference(written.RootElement, regenerated.RootElement, read, GameCodecs.For(gameRelease).Annotations.FormatSortedLists);
    }

    // A document the codec cannot read has no lists to tell apart, so its answer is the one in order.
    private static IMajorRecordGetter? ReadOrNull(byte[] held, GameRelease gameRelease, string recordType)
    {
        try
        {
            return RecordTextCodec.Deserialize(Encoding.UTF8.GetString(held), gameRelease, recordType);
        }
        catch (Exception ex) when (OutOfMemoryOrCancellation.In(ex) is null)
        {
            return null;
        }
    }

    /// <summary>The path of the first member where <paramref name="written"/> and <paramref name="produced"/>
    /// differ, or null when they mean the same.</summary>
    internal static string? FirstDifference(JsonElement written, JsonElement produced) =>
        new Comparison([]).Difference(written, produced, Root, null);

    /// <summary>The same answer, where <paramref name="written"/> reads as <paramref name="read"/>: a set of flags, and a
    /// list <paramref name="sorted"/> names, the format writes in its own order (ADR-0030), so any order means the same.</summary>
    internal static string? FirstDifference(
        JsonElement written, JsonElement produced, object? read, IReadOnlyList<(Type Declarer, string Member)> sorted) =>
        new Comparison(sorted).Difference(written, produced, Root, read);

    private sealed class Comparison(IReadOnlyList<(Type Declarer, string Member)> sorted)
    {
        // read: what the written element reads as, null where that is not known.
        public string? Difference(JsonElement written, JsonElement produced, string path, object? read)
        {
            if (written.ValueKind != produced.ValueKind) return path;
            return written.ValueKind switch
            {
                JsonValueKind.Object => ObjectDifference(written, produced, path, read),
                JsonValueKind.Array => ArrayDifference(written, produced, path, read),
                JsonValueKind.String => written.GetString() == produced.GetString() ? null : path,
                JsonValueKind.Number => NumbersAgree(written, produced) ? null : path,
                _ => null,
            };
        }

        private string? ObjectDifference(JsonElement written, JsonElement produced, string path, object? read)
        {
            foreach (var member in written.EnumerateObject())
            {
                var memberPath = Member(path, member.Name);
                if (!produced.TryGetProperty(member.Name, out var counterpart)) return memberPath;
                var memberRead = read is null || member.Value.ValueKind is not (JsonValueKind.Object or JsonValueKind.Array)
                    ? null
                    : ValueOf(read, member.Name);
                var orderedByFormat = memberRead is Enum || (read is not null && SortedByFormat(read, member.Name));
                var found = member.Value.ValueKind == JsonValueKind.Array && orderedByFormat
                    ? UnorderedDifference(member.Value, counterpart, memberPath, memberRead)
                    : Difference(member.Value, counterpart, memberPath, memberRead);
                if (found is not null) return found;
            }
            return produced.EnumerateObject().Select(member => member.Name).FirstOrDefault(name => !written.TryGetProperty(name, out _)) is { } extra
                ? Member(path, extra)
                : null;
        }

        private string? ArrayDifference(JsonElement written, JsonElement produced, string path, object? read)
        {
            var writtenItems = written.EnumerateArray().ToArray();
            var producedItems = produced.EnumerateArray().ToArray();
            var readItems = ItemsOf(read, writtenItems.Length);
            for (var index = 0; index < Math.Min(writtenItems.Length, producedItems.Length); index++)
            {
                if (Difference(writtenItems[index], producedItems[index], $"{path}[{index}]", readItems[index]) is { } found) return found;
            }
            return writtenItems.Length == producedItems.Length ? null : path;
        }

        // Each written element pairs with a produced element of its meaning, wherever the format put it. The one at
        // its own index is tried first, so a list already in the format's order costs one pass.
        private string? UnorderedDifference(JsonElement written, JsonElement produced, string path, object? read)
        {
            var writtenItems = written.EnumerateArray().ToArray();
            var producedItems = produced.EnumerateArray().ToArray();
            if (writtenItems.Length != producedItems.Length) return path;
            var readItems = ItemsOf(read, writtenItems.Length);
            var unpaired = Enumerable.Range(0, producedItems.Length).ToList();
            for (var index = 0; index < writtenItems.Length; index++)
            {
                var itemPath = $"{path}[{index}]";
                var candidates = unpaired.Contains(index) ? unpaired.Where(at => at != index).Prepend(index) : unpaired;
                var paired = candidates.Where(at => Difference(writtenItems[index], producedItems[at], itemPath, readItems[index]) is null).Take(1).ToList();
                if (paired.Count == 0) return itemPath;
                unpaired.Remove(paired[0]);
            }
            return null;
        }

        private bool SortedByFormat(object read, string member) =>
            sorted.Any(list => list.Member == member && list.Declarer.IsInstanceOfType(read));

        private static readonly ConcurrentDictionary<(Type Owner, string Member), PropertyInfo?> Members = new();

        // The most derived declaration: a class can redeclare a member its base declares.
        private static object? ValueOf(object read, string member) =>
            Members.GetOrAdd((read.GetType(), member), static key =>
            {
                for (var declaring = key.Owner; declaring is not null; declaring = declaring.BaseType)
                {
                    if (declaring.GetProperty(key.Member, BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly) is { } property
                        && property.GetIndexParameters().Length == 0)
                    {
                        return property;
                    }
                }
                return null;
            })?.GetValue(read);

        // An element pairs with what it reads as by index only when the read holds as many as were written.
        private static object?[] ItemsOf(object? read, int count) =>
            read is IEnumerable items and not string && items.Cast<object?>().ToArray() is { } held && held.Length == count ? held : new object?[count];

        // Integers by their digits, so none is rounded to a double. Any other number is the float the codec reads it as.
        private static bool NumbersAgree(JsonElement written, JsonElement produced) =>
            IsInteger(written) && IsInteger(produced)
                ? BigInteger.Parse(written.GetRawText(), CultureInfo.InvariantCulture) == BigInteger.Parse(produced.GetRawText(), CultureInfo.InvariantCulture)
                : written.GetDouble().Equals(produced.GetDouble()) || SameSingle(written, produced);

        private static bool IsInteger(JsonElement number) => number.GetRawText().AsSpan().IndexOfAny(".eE") < 0;

        private static bool SameSingle(JsonElement written, JsonElement produced) =>
            written.TryGetSingle(out var first) && produced.TryGetSingle(out var second) && first.Equals(second);

        private static string Member(string path, string name) => path == Root ? name : $"{path}.{name}";
    }
}
