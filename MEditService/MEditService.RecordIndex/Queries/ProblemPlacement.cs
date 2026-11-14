using MEditService.Codec.Serialization;

namespace MEditService.RecordIndex.Queries;

/// <summary>Where a problem sits in its file's text: the FormKey string it names at its field path, else the first
/// such string in its record, else the first line.</summary>
internal sealed class ProblemPlacement(string text)
{
    private readonly DocumentSpans _document = DocumentSpans.Read(text);
    private readonly TextLines _lines = new(text);

    public SourceRange Of(string? formKey, string? targetFormKey, string? fieldPath) =>
        (targetFormKey ?? formKey) is { } spanned && _document.StringOf(formKey, spanned, fieldPath) is var (start, end)
            ? _lines.RangeOf(start, end)
            : SourceRange.FirstLine;
}
