using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MEditService.ModFolderAdapter;

/// <summary>A manifest as lines of JSON, one per source and one per file in path order, so a change to one file
/// is one line in a diff.</summary>
internal static partial class ManifestText
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
                    && root.TryGetProperty("hash", out var hash) && hash.GetString() is { } hashText && FileHash.IsHash(hashText)
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

    /// <summary>The manifest Of wrote, its files without stamps. Throws <see cref="InvalidDataException"/> naming the
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

    private static ManifestFile FileOf(string path, JsonElement root)
    {
        var hash = Text(root.GetProperty("hash"));
        var provider = root.TryGetProperty("from", out var from) ? ProviderOf(path, hash, from) : new FileProvider.FirstInstallationFile();
        return new ManifestFile(path, hash, null, provider);
    }

    private static FileProvider ProviderOf(string path, string hash, JsonElement from)
    {
        if (from.ValueKind == JsonValueKind.Null) return new FileProvider.NoProvider();
        var baseHash = from.TryGetProperty("delta", out var delta) ? BaseHashOf(Text(delta), path, hash) : null;
        if (from.TryGetProperty("gameFile", out var game))
            return baseHash is null ? new FileProvider.GameFile(Text(game)) : new FileProvider.GameFileDelta(Text(game), baseHash);
        var installationFile = Text(from.GetProperty("installationFile"));
        var entry = Text(from.GetProperty("path"));
        return baseHash is null
            ? new FileProvider.InstallationFileEntry(installationFile, entry)
            : new FileProvider.InstallationFileDelta(installationFile, entry, baseHash);
    }

    private static string BaseHashOf(string deltaName, string path, string fileHash)
    {
        var baseHash = DeltaHashes().Match(deltaName) is { Success: true } match
            ? Convert.ToBase64String(Convert.FromHexString(match.Groups["base"].Value))
            : throw new FormatException();
        return DeltaName(path, baseHash, fileHash) == deltaName ? baseHash : throw new FormatException();
    }

    [GeneratedRegex(@"\.(?<base>[0-9a-f]{16})_[0-9a-f]{16}\.octodiff$")]
    private static partial Regex DeltaHashes();

    /// <summary>A delta's name: the name of the file it makes, then the hashes of its base and of that file.</summary>
    public static string DeltaName(string path, string baseHash, string fileHash) =>
        $"{path[(path.LastIndexOf('/') + 1)..]}.{FileHash.Hex(baseHash)}_{FileHash.Hex(fileHash)}.octodiff";

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
            case FileProvider.InstallationFileDelta delta:
                writer.WriteStartObject("from");
                writer.WriteString("installationFile", delta.InstallationFile);
                writer.WriteString("path", delta.Path);
                writer.WriteString("delta", DeltaName(file.Path, delta.BaseHash, file.Hash));
                writer.WriteEndObject();
                break;
            case FileProvider.GameFileDelta delta:
                writer.WriteStartObject("from");
                writer.WriteString("gameFile", delta.Path);
                writer.WriteString("delta", DeltaName(file.Path, delta.BaseHash, file.Hash));
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
