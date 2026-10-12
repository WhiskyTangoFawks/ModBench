using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace MEditService.ModFolderAdapter;

/// <summary>A manifest as lines of JSON, one per source and one per file in path order, so a change to one file
/// is one line in a diff.</summary>
internal static class ManifestText
{
    private static readonly JsonWriterOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static string Of(Manifest manifest)
    {
        var text = new StringBuilder();
        foreach (var source in manifest.InstallationFiles) Line(text, writer => Source(writer, "installationFile", source));
        foreach (var source in manifest.GameFiles.OrderBy(s => s.Name, StringComparer.Ordinal))
            Line(text, writer => Source(writer, "gameFile", source));
        foreach (var file in manifest.Files.OrderBy(f => f.Path, StringComparer.Ordinal)) Line(text, writer => FileLine(writer, file));
        return text.ToString();
    }

    public static Dictionary<string, LineStamp> LineStamps(string text)
    {
        Dictionary<string, LineStamp> stamps = new(StringComparer.Ordinal);
        foreach (var line in text.Split('\n'))
        {
            try
            {
                using var parsed = JsonDocument.Parse(line);
                var root = parsed.RootElement;
                if (root.ValueKind == JsonValueKind.Object
                    && root.TryGetProperty("path", out var path) && path.GetString() is { } file
                    && root.TryGetProperty("hash", out var hash) && hash.GetString() is { } hashText
                    && root.TryGetProperty("size", out var size) && size.TryGetInt64(out var bytes)
                    && root.TryGetProperty("modified", out var modified) && modified.TryGetInt64(out var at))
                {
                    stamps[file] = new LineStamp(bytes, at, hashText);
                }
            }
            catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
            {
                // A line that is not one of ours, as a merge conflict leaves, vouches for nothing.
            }
        }
        return stamps;
    }

    private static void Line(StringBuilder text, Action<Utf8JsonWriter> write)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, Compact)) write(writer);
        text.Append(Encoding.UTF8.GetString(buffer.ToArray())).Append('\n');
    }

    private static void Source(Utf8JsonWriter writer, string kind, ManifestSource source)
    {
        writer.WriteStartObject();
        writer.WriteString(kind, source.Name);
        writer.WriteNumber("size", source.Size);
        writer.WriteString("hash", source.Hash);
        if (source.Source is { } origin) writer.WriteString("source", origin);
        writer.WriteEndObject();
    }

    private static void FileLine(Utf8JsonWriter writer, ManifestFile file)
    {
        writer.WriteStartObject();
        writer.WriteString("path", file.Path);
        writer.WriteString("hash", file.Hash);
        if (file.Stamp is { } stamp)
        {
            writer.WriteNumber("size", stamp.Size);
            writer.WriteNumber("modified", stamp.Modified);
        }
        switch (file.Provider)
        {
            case FileProvider.InstallationFileEntry entry:
                writer.WriteStartObject("from");
                writer.WriteString("installationFile", entry.InstallationFile);
                writer.WriteString("path", entry.Path);
                writer.WriteEndObject();
                break;
            case FileProvider.GameFile game:
                writer.WriteStartObject("from");
                writer.WriteString("gameFile", game.Path);
                writer.WriteEndObject();
                break;
            case FileProvider.NoProvider:
                writer.WriteNull("from");
                break;
        }
        writer.WriteEndObject();
    }
}

/// <summary>What a manifest's file line says of its file: the size and time it was hashed at, and the hash.</summary>
internal readonly record struct LineStamp(long Size, long Modified, string Hash);
