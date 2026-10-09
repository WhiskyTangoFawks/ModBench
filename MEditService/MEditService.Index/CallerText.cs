using MEditService.Codec.Serialization;

namespace MEditService.Index;

internal static class CallerText
{
    /// <summary>The body a copy is read from when the caller's text yields none.</summary>
    public const string NoBody = "{}";

    internal static (string Body, string? EditorId, string? ParseDiagnosis) Read(string text)
    {
        if (!Document.TryRead(text, out var document, out var whyNot)) return (NoBody, null, whyNot);
        var editorId = document.EditorId;
        return editorId.WhyUnreadable is { } why ? (NoBody, null, $"The record's {why}.") : (text, editorId.EditorId, null);
    }
}
