using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MEditService.RecordIndex.Queries;

/// <summary>Where a problem sits in its file's text: the FormKey string it names at its field path, else the first
/// such string in its record, else the first line.</summary>
internal sealed partial class ProblemPlacement
{
    private readonly byte[] _bytes;
    private readonly Node? _root;

    private sealed record Node(int Start, int End, string? Value, List<(string Name, Node Value)>? Members, List<Node>? Items)
    {
        public IEnumerable<Node> Children => Members?.Select(member => member.Value) ?? Items ?? [];

        public bool IsStringOf(string formKey) => Value is { } text && Canonical(text) == Canonical(formKey);

        public Node? Member(string name) => Members?.FirstOrDefault(member => member.Name == name).Value;

        public Node? At(IReadOnlyList<object> path) => path.Aggregate((Node?)this, (node, segment) => node?.Step(segment));

        private Node? Step(object segment)
        {
            if (segment is not int index) return Member((string)segment);
            return Items is { } items && index < items.Count ? items[index] : null;
        }

        public Node? FirstDeep(Func<Node, bool> matches) =>
            matches(this) ? this : Children.Select(child => child.FirstDeep(matches)).FirstOrDefault(found => found is not null);
    }

    public ProblemPlacement(string text)
    {
        _bytes = Encoding.UTF8.GetBytes(text);
        _root = Parse(_bytes);
    }

    public SourceRange Of(string? formKey, string? targetFormKey, string? fieldPath)
    {
        var scope = _root is not null && formKey is not null ? RecordOf(_root, formKey) ?? _root : _root;
        var spanned = targetFormKey ?? formKey;
        var target = scope is not null && spanned is not null ? StringIn(scope, spanned, fieldPath) : null;
        return target is null ? SourceRange.FirstLine : new(PositionAt(target.Start), PositionAt(target.End));
    }

    private static Node? RecordOf(Node root, string formKey) =>
        root.FirstDeep(node => node.Member("FormKey")?.IsStringOf(formKey) == true);

    private static Node? StringIn(Node scope, string spanned, string? fieldPath)
    {
        bool Names(Node node) => node.IsStringOf(spanned);
        return fieldPath is not null && scope.At(LocationOf(fieldPath)) is { } atPath && Names(atPath) ? atPath : scope.FirstDeep(Names);
    }

    // Mutagen reads either delimiter and either hex case as one FormKey.
    private static string Canonical(string text) =>
        FormKeyShape().IsMatch(text) ? $"{text[..6].ToUpperInvariant()}:{text[7..]}" : text;

    [GeneratedRegex(@"^[0-9A-F]{6}[:_].+\.(esm|esp|esl)$", RegexOptions.IgnoreCase)]
    private static partial Regex FormKeyShape();

    // A field path is the document's member names, an element's index in brackets.
    private static List<object> LocationOf(string fieldPath) =>
        [.. fieldPath.Split('.').SelectMany(member => ((object[])[member.Split('[')[0]])
            .Concat(ElementIndex().Matches(member).Select(index => (object)int.Parse(index.Groups[1].Value))))];

    [GeneratedRegex(@"\[(\d+)\]")]
    private static partial Regex ElementIndex();

    private static Node? Parse(byte[] bytes)
    {
        try
        {
            var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
            return reader.Read() ? ReadValue(ref reader) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static Node ReadValue(ref Utf8JsonReader reader)
    {
        var start = (int)reader.TokenStartIndex;
        switch (reader.TokenType)
        {
            case JsonTokenType.StartObject:
                var members = new List<(string, Node)>();
                while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
                {
                    var name = reader.GetString() ?? "";
                    reader.Read();
                    members.Add((name, ReadValue(ref reader)));
                }
                return new(start, (int)reader.BytesConsumed, null, members, null);
            case JsonTokenType.StartArray:
                var items = new List<Node>();
                while (reader.Read() && reader.TokenType != JsonTokenType.EndArray) items.Add(ReadValue(ref reader));
                return new(start, (int)reader.BytesConsumed, null, null, items);
            case JsonTokenType.String:
                return new(start, (int)reader.BytesConsumed, reader.GetString(), null, null);
            default:
                return new(start, (int)reader.BytesConsumed, null, null, null);
        }
    }

    private SourcePosition PositionAt(int byteOffset)
    {
        var before = Encoding.UTF8.GetString(_bytes, 0, byteOffset);
        var line = 0;
        var lineStart = 0;
        for (var i = 0; i < before.Length; i++)
        {
            if (before[i] is not ('\r' or '\n')) continue;
            if (before[i] == '\r' && i + 1 < before.Length && before[i + 1] == '\n') continue;
            line++;
            lineStart = i + 1;
        }
        return new(line, before.Length - lineStart);
    }
}
