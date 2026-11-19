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
        return FirstDifference(written.RootElement, regenerated.RootElement, read, gameRelease);
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
        new Comparison(null).Difference(written, produced, Root, null);

    /// <summary>The same answer, where <paramref name="written"/> reads as <paramref name="writtenReadAs"/>: a set of
    /// flags, and a list the format sorts, the format writes in its own order (ADR-0030), so any order means the same.</summary>
    internal static string? FirstDifference(JsonElement written, JsonElement produced, object? writtenReadAs, GameRelease gameRelease) =>
        new Comparison(GameCodecs.For(gameRelease).Annotations).Difference(written, produced, Root, writtenReadAs);

    private sealed class Comparison(SchemaAnnotations? annotations)
    {
        public string? Difference(JsonElement written, JsonElement produced, string path, object? writtenReadAs)
        {
            if (written.ValueKind != produced.ValueKind) return path;
            return written.ValueKind switch
            {
                JsonValueKind.Object => ObjectDifference(written, produced, path, writtenReadAs),
                JsonValueKind.Array => ArrayDifference(written, produced, path, writtenReadAs),
                JsonValueKind.String => written.GetString() == produced.GetString() ? null : path,
                JsonValueKind.Number => NumbersAgree(written, produced) ? null : path,
                _ => null,
            };
        }

        private string? ObjectDifference(JsonElement written, JsonElement produced, string path, object? writtenReadAs)
        {
            foreach (var member in written.EnumerateObject())
            {
                var memberPath = Member(path, member.Name);
                if (!produced.TryGetProperty(member.Name, out var counterpart)) return memberPath;
                var memberReadAs = writtenReadAs is null || member.Value.ValueKind is not (JsonValueKind.Object or JsonValueKind.Array)
                    ? null
                    : ValueOf(writtenReadAs, member.Name);
                var orderedByFormat = writtenReadAs is not null
                    && (memberReadAs is Enum || annotations?.IsSortedByFormat(writtenReadAs.GetType(), member.Name) == true);
                var found = member.Value.ValueKind == JsonValueKind.Array && orderedByFormat
                    ? UnorderedDifference(member.Value, counterpart, memberPath, memberReadAs)
                    : Difference(member.Value, counterpart, memberPath, memberReadAs);
                if (found is not null) return found;
            }
            return produced.EnumerateObject().Select(member => member.Name).FirstOrDefault(name => !written.TryGetProperty(name, out _)) is { } extra
                ? Member(path, extra)
                : null;
        }

        private string? ArrayDifference(JsonElement written, JsonElement produced, string path, object? writtenReadAs)
        {
            var writtenItems = written.EnumerateArray().ToArray();
            var producedItems = produced.EnumerateArray().ToArray();
            var readItems = ItemsOf(writtenReadAs, writtenItems.Length);
            for (var index = 0; index < Math.Min(writtenItems.Length, producedItems.Length); index++)
            {
                if (Difference(writtenItems[index], producedItems[index], $"{path}[{index}]", readItems[index]) is { } found) return found;
            }
            return writtenItems.Length == producedItems.Length ? null : path;
        }

        // Each written element pairs with a produced element of its meaning, wherever the format put it. The one at
        // its own index is tried first, so a list already in the format's order costs one pass.
        private string? UnorderedDifference(JsonElement written, JsonElement produced, string path, object? writtenReadAs)
        {
            var writtenItems = written.EnumerateArray().ToArray();
            var producedItems = produced.EnumerateArray().ToArray();
            if (writtenItems.Length != producedItems.Length) return path;
            var readItems = ItemsOf(writtenReadAs, writtenItems.Length);
            var unpaired = Enumerable.Range(0, producedItems.Length).ToList();
            for (var index = 0; index < writtenItems.Length; index++)
            {
                var itemPath = $"{path}[{index}]";
                var candidates = (unpaired.Contains(index) ? unpaired.Where(at => at != index).Prepend(index) : unpaired).ToList();
                var paired = candidates.Where(at => Difference(writtenItems[index], producedItems[at], itemPath, readItems[index]) is null).Take(1).ToList();
                if (paired.Count == 0)
                {
                    var nearest = candidates.MaxBy(at => MembersAgreeing(writtenItems[index], producedItems[at]));
                    return Difference(writtenItems[index], producedItems[nearest], itemPath, readItems[index]) ?? itemPath;
                }
                unpaired.Remove(paired[0]);
            }
            return null;
        }

        private int MembersAgreeing(JsonElement written, JsonElement produced) =>
            written.ValueKind == JsonValueKind.Object && produced.ValueKind == JsonValueKind.Object
                ? written.EnumerateObject().Count(member =>
                    produced.TryGetProperty(member.Name, out var counterpart) && Difference(member.Value, counterpart, Root, null) is null)
                : 0;

        private static readonly ConcurrentDictionary<(Type Owner, string Member), PropertyInfo?> Members = new();

        private static object? ValueOf(object readAs, string member) =>
            Members.GetOrAdd((readAs.GetType(), member), static key =>
                key.Owner.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                    .Where(property => property.Name == key.Member && property.GetIndexParameters().Length == 0)
                    .ToList() is { Count: > 0 } declarations
                    ? ReflectedTypes.MostDerived(declarations)
                    : null) is { } held
                ? ReflectedTypes.ReadOrNull(readAs, held)
                : null;

        private static object?[] ItemsOf(object? readAs, int count) =>
            readAs is IEnumerable items and not string && items.Cast<object?>().ToArray() is { } held && held.Length == count ? held : new object?[count];

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
