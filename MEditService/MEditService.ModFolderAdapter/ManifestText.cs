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

    /// <summary>The manifest Of wrote. Throws <see cref="InvalidDataException"/> naming the
    /// first line it cannot read.</summary>
    public static Manifest Parse(string text)
    {
        List<ManifestSource> installationFiles = [], gameFiles = [];
        List<ManifestFile> files = [];
        foreach (var (at, line) in text.Split('\n').Index())
        {
            if (line.Length == 0) continue;
            try
            {
                using var parsed = JsonDocument.Parse(line);
                var root = parsed.RootElement;
                if (root.TryGetProperty("path", out var path)) files.Add(FileOf(Text(path), root));
                else if (root.TryGetProperty("installationFile", out var name)) installationFiles.Add(SourceOf(name, root));
                else if (root.TryGetProperty("gameFile", out var game)) gameFiles.Add(SourceOf(game, root));
                else throw new FormatException();
            }
            catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException or KeyNotFoundException)
            {
                throw new InvalidDataException($"its manifest cannot be read at line {at + 1}", e);
            }
        }
        return new Manifest(installationFiles, gameFiles, files);
    }

    private static string Text(JsonElement value) => value.GetString() ?? throw new FormatException();

    private static ManifestSource SourceOf(JsonElement name, JsonElement root) => new(
        Text(name), root.GetProperty("size").GetInt64(), Text(root.GetProperty("hash")),
        root.TryGetProperty("source", out var source) ? Text(source) : null);

    private static ManifestFile FileOf(string path, JsonElement root) =>
        new(path, root.TryGetProperty("from", out var from) ? ProviderOf(from) : new FileProvider.FirstInstallationFile());

    private static FileProvider ProviderOf(JsonElement from)
    {
        if (from.ValueKind == JsonValueKind.Null) return new FileProvider.NoProvider();
        if (from.TryGetProperty("gameFile", out var game)) return new FileProvider.GameFile(Text(game));
        if (from.TryGetProperty("remote", out var remote)) return new FileProvider.Source(Text(remote), Text(from.GetProperty("commit")));
        return new FileProvider.InstallationFileEntry(Text(from.GetProperty("installationFile")), Text(from.GetProperty("path")));
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
            case FileProvider.Source source:
                writer.WriteStartObject("from");
                writer.WriteString("remote", source.Remote);
                writer.WriteString("commit", source.Commit);
                writer.WriteEndObject();
                break;
            case FileProvider.NoProvider:
                writer.WriteNull("from");
                break;
        }
        writer.WriteEndObject();
    }
}
