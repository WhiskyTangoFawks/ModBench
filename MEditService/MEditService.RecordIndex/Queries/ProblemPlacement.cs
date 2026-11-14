using MEditService.Codec.Serialization;

namespace MEditService.RecordIndex.Queries;

/// <summary>Where a problem sits in its file's text: the FormKey string it names at its field path, else the first
/// such string in its record, else the first line.</summary>
internal sealed class ProblemPlacement(string text)
{
    private readonly DocumentSpans _document = DocumentSpans.Read(text);

    public SourceRange Of(string? formKey, string? targetFormKey, string? fieldPath) =>
        (targetFormKey ?? formKey) is { } spanned && _document.StringOf(formKey, spanned, fieldPath) is var (start, end)
            ? new(PositionAt(start), PositionAt(end))
            : SourceRange.FirstLine;

    private SourcePosition PositionAt(int offset)
    {
        var line = 0;
        var lineStart = 0;
        for (var i = 0; i < offset; i++)
        {
            if (text[i] is not ('\r' or '\n')) continue;
            if (text[i] == '\r' && i + 1 < offset && text[i + 1] == '\n') continue;
            line++;
            lineStart = i + 1;
        }
        return new(line, offset - lineStart);
    }
}
