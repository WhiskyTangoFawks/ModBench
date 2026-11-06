using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>A document of a plugin's source as it reads once a change it names is followed: every other byte stays.</summary>
internal static class FollowedDocument
{
    /// <summary><paramref name="bytes"/> with each string naming <paramref name="from"/> naming <paramref name="to"/>.</summary>
    internal static byte[] FormKeyChanged(string relativePath, byte[] bytes, FormKey from, FormKey to) =>
        Spliced(relativePath, bytes, (byte[] text, out byte[]? changed, out string? whyNot) =>
            RecordDocumentEdits.TryWithFormKeyChanged(text, from, to, out changed, out whyNot));

    internal delegate bool Splice(byte[] text, out byte[]? spliced, out string? whyNot);

    internal static byte[] Spliced(string relativePath, byte[] bytes, Splice splice)
    {
        var text = DocumentText.StripUtf8Bom(bytes);
        var bom = bytes[..^text.Length];
        return splice(text, out var spliced, out var whyNot) && spliced is not null
            ? [.. bom, .. spliced]
            : throw SourceStopException.Unreadable(new UnreadableFile(
                relativePath, $"'{relativePath}' in this plugin's source tree is no JSON document: {whyNot?.TrimEnd('.')}."));
    }
}
