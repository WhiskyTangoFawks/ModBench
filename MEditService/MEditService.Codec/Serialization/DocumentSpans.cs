using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;

namespace MEditService.Codec.Serialization;

/// <summary>A document's text, each value at the span that spells it, by the text's own character offsets. Text being
/// typed reads as far as it goes, so completion reads a document that is not yet whole.</summary>
public sealed class DocumentSpans
{
    private readonly string _text;
    private int _at;

    private DocumentSpans(string text)
    {
        _text = text;
        Root = ReadValue(null);
    }

    internal SpanNode? Root { get; }

    public static DocumentSpans Read(string text) => new(text);

    /// <summary>The canonical FormKey of every record the document holds, outermost first.</summary>
    public IEnumerable<string> RecordFormKeys => Records.Select(record => record.OwnFormKey).OfType<string>();

    /// <summary>The span of a string spelling <paramref name="spanned"/> in the record <paramref name="formKey"/> names, or
    /// in the whole document without it: the one at <paramref name="fieldPath"/>, else the first; null where none.</summary>
    public (int Start, int End)? StringOf(string? formKey, string spanned, string? fieldPath)
    {
        var scope = formKey is not null ? RecordOf(formKey) ?? Root : Root;
        if (scope is null) return null;
        var found = fieldPath is not null && scope.At(fieldPath) is { } atPath && atPath.IsStringOf(spanned)
            ? atPath
            : scope.SelfAndDescendants().FirstOrDefault(node => node.IsStringOf(spanned));
        return found is null ? null : (found.Start, found.End);
    }

    /// <summary>Each string the record <paramref name="formKey"/> holds at one of <paramref name="fieldPaths"/>, by the span
    /// between its quotes, with its value.</summary>
    public IReadOnlyList<(int Start, int End, string Value)> StringsAt(string formKey, IReadOnlyList<string> fieldPaths) =>
        RecordOf(formKey) is { } record
            ? [.. fieldPaths.Select(record.At).OfType<SpanNode>().Where(node => node.Text is not null)
                .Select(node => (node.Inside.Start, node.Inside.End, node.Text ?? ""))]
            : [];

    internal IEnumerable<SpanNode> Records => Root?.SelfAndDescendants().Where(node => node.OwnFormKey is not null) ?? [];

    private SpanNode? RecordOf(string formKey) => Records.FirstOrDefault(record => record.Member(RecordMembers.FormKey)?.IsStringOf(formKey) == true);

    private SpanNode? ReadValue(SpanNode? parent)
    {
        SkipTrivia();
        if (_at >= _text.Length) return null;
        return _text[_at] switch
        {
            '{' => ReadObject(parent),
            '[' => ReadArray(parent),
            '"' => ReadString(parent),
            '}' or ']' or ',' or ':' => null,
            _ => ReadLiteral(parent),
        };
    }

    // An unclosed object ends at a stray closing bracket, which its holder reads.
    private SpanNode ReadObject(SpanNode? parent)
    {
        var node = new SpanNode { Start = _at++, Parent = parent, Members = [] };
        while (true)
        {
            SkipTrivia();
            if (_at >= _text.Length || _text[_at] == ']') break;
            var next = _text[_at];
            if (next == '}')
            {
                _at++;
                break;
            }
            if (next == ',')
            {
                _at++;
                continue;
            }
            if (next != '"')
            {
                if (ReadValue(node) is null) _at++;
                continue;
            }
            var key = ReadString(node);
            SkipTrivia();
            SpanNode? value = null;
            if (_at < _text.Length && _text[_at] == ':')
            {
                _at++;
                value = ReadValue(node);
            }
            node.Members.Add(new SpanMember(key.Text ?? "", key.Start, value));
        }
        node.End = _at;
        return node;
    }

    private SpanNode ReadArray(SpanNode? parent)
    {
        var node = new SpanNode { Start = _at++, Parent = parent, Items = [] };
        while (true)
        {
            SkipTrivia();
            if (_at >= _text.Length || _text[_at] == '}') break;
            var next = _text[_at];
            if (next == ']')
            {
                _at++;
                break;
            }
            if (next == ',')
            {
                _at++;
                continue;
            }
            if (ReadValue(node) is { } item) node.Items.Add(item);
            else _at++;
        }
        node.End = _at;
        return node;
    }

    // A string being typed has no closing quote yet; it ends at the line break, as an editor shows it.
    private SpanNode ReadString(SpanNode? parent)
    {
        var start = _at++;
        var value = new StringBuilder();
        var closed = false;
        while (_at < _text.Length)
        {
            var c = _text[_at];
            if (c is '\r' or '\n') break;
            _at++;
            if (c == '"')
            {
                closed = true;
                break;
            }
            if (c != '\\') value.Append(c);
            else if (_at < _text.Length) value.Append(Escaped());
        }
        return new SpanNode { Start = start, End = _at, Parent = parent, Text = value.ToString(), Closed = closed };
    }

    private string Escaped()
    {
        var c = _text[_at++];
        switch (c)
        {
            case 'b': return "\b";
            case 'f': return "\f";
            case 'n': return "\n";
            case 'r': return "\r";
            case 't': return "\t";
            case 'u' when _at + 4 <= _text.Length
                && int.TryParse(_text.AsSpan(_at, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var code):
                _at += 4;
                return ((char)code).ToString();
            default: return c.ToString();
        }
    }

    private SpanNode ReadLiteral(SpanNode? parent)
    {
        var start = _at;
        while (_at < _text.Length && !char.IsWhiteSpace(_text[_at]) && _text[_at] is not (',' or '}' or ']' or ':' or '"' or '{' or '[' or '/')) _at++;
        if (_at == start) _at++;
        return new SpanNode { Start = start, End = _at, Parent = parent, Literal = _text[start.._at] };
    }

    private void SkipTrivia()
    {
        while (_at < _text.Length)
        {
            if (char.IsWhiteSpace(_text[_at])) _at++;
            else if (_text.AsSpan(_at).StartsWith("//")) _at = LineEnd(_at);
            else if (_text.AsSpan(_at).StartsWith("/*")) _at = _text.IndexOf("*/", _at + 2, StringComparison.Ordinal) is var end and >= 0 ? end + 2 : _text.Length;
            else return;
        }
    }

    private int LineEnd(int from) => _text.IndexOfAny(['\r', '\n'], from) is var end and >= 0 ? end : _text.Length;
}

/// <summary>A member of an object: its name, where its name starts, and its value, none where the text gives none.</summary>
internal sealed record SpanMember(string Name, int Start, SpanNode? Value);

/// <summary>A value in a document's text, and the span that spells it.</summary>
internal sealed class SpanNode
{
    public required int Start { get; init; }
    public int End { get; internal set; }
    public SpanNode? Parent { get; init; }

    /// <summary>A string's value; null for any other value.</summary>
    public string? Text { get; init; }

    /// <summary>Whether a string's closing quote is in the text.</summary>
    public bool Closed { get; init; }

    /// <summary>A number's, a boolean's or null's own text.</summary>
    public string? Literal { get; init; }

    public List<SpanMember>? Members { get; init; }
    public List<SpanNode>? Items { get; init; }

    /// <summary>The span between a string's quotes.</summary>
    public (int Start, int End) Inside => (Start + 1, Closed ? End - 1 : End);

    public SpanNode? Member(string name) => Members?.LastOrDefault(member => member.Name == name)?.Value;

    /// <summary>The canonical FormKey this object's own <c>FormKey</c> member holds; null when it holds none.</summary>
    public string? OwnFormKey => Member(RecordMembers.FormKey)?.Text is { } spelled ? CanonicalFormKey.OfLink(spelled) : null;

    /// <summary>The nearest record holding this node: itself when it is one.</summary>
    public SpanNode? Record => OwnFormKey is not null ? this : Parent?.Record;

    /// <summary>Whether this is a string spelling <paramref name="formKey"/>, either delimiter and either hex case alike.</summary>
    public bool IsStringOf(string formKey) =>
        Text is { } spelled && CanonicalFormKey.OfOrAsWritten(spelled) == CanonicalFormKey.OfOrAsWritten(formKey);

    /// <summary>The node at a field path from this one: the document's own member names, an element's index in brackets.</summary>
    public SpanNode? At(string fieldPath) => SegmentsOf(fieldPath).Aggregate((SpanNode?)this, (node, segment) => segment switch
    {
        int index => node?.Items is { } items && index < items.Count ? items[index] : null,
        _ => node?.Member((string)segment),
    });

    /// <summary>The field path from <paramref name="ancestor"/> to this node.</summary>
    public string PathFrom(SpanNode ancestor)
    {
        var segments = new List<string>();
        for (var node = this; node != ancestor && node.Parent is { } parent; node = parent)
        {
            if (parent.Items is { } items) segments.Add($"[{items.IndexOf(node)}]");
            else if (parent.Members?.FindLast(member => member.Value == node) is { } member) segments.Add($".{member.Name}");
        }
        segments.Reverse();
        return string.Concat(segments).TrimStart('.');
    }

    public IEnumerable<SpanNode> SelfAndDescendants()
    {
        yield return this;
        foreach (var child in Children)
        {
            foreach (var node in child.SelfAndDescendants()) yield return node;
        }
    }

    private IEnumerable<SpanNode> Children =>
        Members?.Select(member => member.Value).OfType<SpanNode>() ?? Items ?? Enumerable.Empty<SpanNode>();

    /// <summary>The value the text spells; a literal that spells none reads as nothing.</summary>
    public JsonNode? ToJsonNode()
    {
        if (Text is { } text) return JsonValue.Create(text);
        if (Items is { } items) return new JsonArray([.. items.Select(item => item.ToJsonNode())]);
        if (Members is { } members)
        {
            var obj = new JsonObject();
            foreach (var member in members) obj[member.Name] = member.Value?.ToJsonNode();
            return obj;
        }
        try
        {
            return JsonNode.Parse(Literal ?? "null");
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }

    private static IEnumerable<object> SegmentsOf(string fieldPath) =>
        fieldPath.Split('.').SelectMany(member =>
        {
            var bracket = member.IndexOf('[', StringComparison.Ordinal);
            var name = bracket < 0 ? member : member[..bracket];
            IEnumerable<object> indices = bracket < 0 ? [] : member[bracket..].Split(['[', ']'], StringSplitOptions.RemoveEmptyEntries)
                .Select(index => (object)int.Parse(index, CultureInfo.InvariantCulture));
            return ((object[])[name]).Concat(indices);
        });
}
