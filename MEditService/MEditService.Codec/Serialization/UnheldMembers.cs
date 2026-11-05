using System.Collections;
using System.Collections.Concurrent;
using System.IO.Abstractions;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Loqui;
using MEditService.Codec.Schema;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;
using Noggog.IO;

namespace MEditService.Codec.Serialization;

/// <summary>Mutagen's serializer writes a member a versioning break leaves unheld as whatever the
/// object holds in its stead. A document holds only what the record holds, so the codec leaves it out.</summary>
public static class UnheldMembers
{
    private static readonly byte[] Marker = Encoding.UTF8.GetBytes($"\"{VersioningBreaks.Member}\"");

    /// <summary><paramref name="json"/>, the document of <paramref name="graph"/>, without the members its
    /// breaks leave unheld, every other byte as it was.</summary>
    internal static byte[] Without(byte[] json, object graph) => Without(json, _ => graph);

    private static byte[] Without(byte[] json, Func<JsonNode?, object> graphOf)
    {
        if (json.AsSpan().IndexOf(Marker) < 0) return json;
        var root = JsonNode.Parse(json);
        var unheld = new List<object[]>();
        Collect(graphOf(root), root, [], unheld);
        foreach (var path in unheld) json = WithoutMember(json, path);
        return json;
    }

    /// <summary>The whole-mod door's streams over <paramref name="streamCreator"/>'s, each document written
    /// without them as it closes: a record's by its FormKey, the root's by the plugin.</summary>
    public static ICreateStream LeavingOut(IModGetter plugin, ICreateStream streamCreator) => new LeftOut(plugin, streamCreator);

    private sealed class LeftOut(IModGetter plugin, ICreateStream inner) : ICreateStream
    {
        private readonly Lazy<Dictionary<string, IMajorRecordGetter>> _records =
            new(() => plugin.EnumerateMajorRecords().ToDictionary(record => record.FormKey.ToString(), StringComparer.Ordinal));

        public Stream GetStreamFor(IFileSystem fileSystem, FilePath path, bool write) => write
            ? new WrittenOnClose(json =>
            {
                using var target = inner.GetStreamFor(fileSystem, path, write);
                target.Write(Without(json, GraphOf));
            })
            : inner.GetStreamFor(fileSystem, path, write);

        private object GraphOf(JsonNode? root) =>
            root?[RecordMembers.FormKey]?.GetValue<string>() is { } formKey && _records.Value.TryGetValue(formKey, out var record)
                ? record
                : plugin;
    }

    private sealed class WrittenOnClose(Action<byte[]> written) : MemoryStream
    {
        private bool _closed;

        protected override void Dispose(bool disposing)
        {
            if (disposing && !_closed)
            {
                _closed = true;
                written(ToArray());
            }
            base.Dispose(disposing);
        }
    }

    private static void Collect(object? node, JsonNode? json, object[] path, List<object[]> unheld)
    {
        switch (json)
        {
            case JsonObject members when node is not null:
                var unheldWhen = node is ILoquiObject loqui ? VersioningBreaks.UnheldWhen(loqui.Registration.ClassType) : null;
                var breaks = members[VersioningBreaks.Member] is JsonArray flags
                    ? flags.Select(flag => $"{VersioningBreaks.Member}.{flag?.GetValue<string>()}").ToHashSet(StringComparer.Ordinal)
                    : [];
                foreach (var (name, child) in members)
                {
                    if (unheldWhen is not null && unheldWhen.TryGetValue(name, out var under) && under.Any(breaks.Contains))
                        unheld.Add([.. path, name]);
                    else if (PropertyOf(node.GetType(), name) is { } property)
                        Collect(ReflectedTypes.ReadOrNull(node, property), child, [.. path, name], unheld);
                }
                break;
            case JsonArray elements when node is IEnumerable items and not string:
                var index = 0;
                foreach (var item in items)
                {
                    if (index >= elements.Count) break;
                    Collect(item, elements[index], [.. path, index], unheld);
                    index++;
                }
                break;
        }
    }

    private static readonly ConcurrentDictionary<(Type, string), PropertyInfo?> Properties = new();

    private static PropertyInfo? PropertyOf(Type type, string name) => Properties.GetOrAdd((type, name), key =>
        ReflectedTypes.GetAllInterfaceProperties(key.Item1).FirstOrDefault(p => p.Name == key.Item2 && p.GetIndexParameters().Length == 0));

    private static byte[] WithoutMember(byte[] json, object[] path)
    {
        var reader = new Utf8JsonReader(json);
        reader.Read();
        if (Span(ref reader, path, 0) is not var (start, end)) return json;
        return [.. json.AsSpan(0, start), .. json.AsSpan(end)];
    }

    // Mutagen writes a class's Versioning ahead of every member past its breaks, so a comma precedes each.
    private static (int Start, int End)? Span(ref Utf8JsonReader reader, object[] path, int hop)
    {
        if (reader.TokenType == JsonTokenType.StartObject && path[hop] is string member)
        {
            int? previousEnd = null;
            while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
            {
                var name = reader.GetString();
                reader.Read();
                if (name == member)
                {
                    if (hop < path.Length - 1) return Span(ref reader, path, hop + 1);
                    reader.Skip();
                    return (previousEnd ?? throw new InvalidOperationException($"Expected '{VersioningBreaks.Member}' ahead of unheld '{member}'."),
                        (int)reader.BytesConsumed);
                }
                reader.Skip();
                previousEnd = (int)reader.BytesConsumed;
            }
        }
        else if (reader.TokenType == JsonTokenType.StartArray && path[hop] is int element)
        {
            var index = 0;
            while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
            {
                if (index++ == element) return Span(ref reader, path, hop + 1);
                reader.Skip();
            }
        }
        return null;
    }
}
