using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace MEditService.ModFolderAdapter;

/// <summary>A manifest as a JSON file: a line for its package with its version, or for the version alone, and a line for
/// each file in alphabetical order, so a diff shows one line per change.</summary>
internal static class ManifestText
{
    private static readonly JsonWriterOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static string Of(Manifest manifest)
    {
        List<string> members = [];
        if (manifest.Package is not null) members.Add("\"package\": " + Value(writer => PackageLine(writer, manifest.Package, manifest.Version)));
        else if (manifest.Version is { } version) members.Add("\"version\": " + Value(writer => writer.WriteStringValue(version)));
        var files = manifest.Files.OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase).ThenBy(file => file.Path, StringComparer.Ordinal).Select(file => Value(writer => FileLine(writer, file))).ToList();
        members.Add(files.Count == 0 ? "\"files\": []" : "\"files\": [\n" + string.Join(",\n", files) + "\n]");
        return "{\n" + string.Join(",\n", members) + "\n}\n";
    }

    /// <summary>The manifest Of wrote. Throws <see cref="InvalidDataException"/> naming where it cannot read it.</summary>
    public static Manifest Parse(string text)
    {
        try
        {
            using var parsed = JsonDocument.Parse(text);
            var root = parsed.RootElement;
            var files = root.GetProperty("files").EnumerateArray().Index().Select(entry => FileOf(entry.Index, entry.Item)).ToList();
            if (root.TryGetProperty("package", out var line))
            {
                var (package, version) = PackageOf(line);
                return new Manifest(package, files, version);
            }
            return new Manifest(null, files, root.TryGetProperty("version", out var alone) ? Text(alone) : null);
        }
        catch (JsonException e)
        {
            throw new InvalidDataException($"its manifest cannot be read{(e.LineNumber is { } line ? $" at line {line + 1}" : "")}", e);
        }
        catch (Exception e) when (e is InvalidOperationException or FormatException or KeyNotFoundException)
        {
            throw new InvalidDataException("its manifest cannot be read", e);
        }
    }

    private static string Text(JsonElement value) => value.GetString() ?? throw new FormatException();

    private static (ManifestPackage Package, string? Version) PackageOf(JsonElement line)
    {
        var version = line.TryGetProperty("version", out var held) ? Text(held) : null;
        if (line.TryGetProperty("installationFile", out var name))
        {
            return (new ManifestPackage.InstallationFile(
                Text(name), line.GetProperty("size").GetInt64(), Text(line.GetProperty("hash")),
                line.TryGetProperty("page", out var page) ? Text(page) : null), version);
        }
        if (line.TryGetProperty("gameFolder", out var game)) return (new ManifestPackage.GameFolder(Text(game), Text(line.GetProperty("hash"))), version);
        return (new ManifestPackage.SourceMod(Text(line.GetProperty("remote")), Text(line.GetProperty("commit"))), version);
    }

    private static ManifestFile FileOf(int index, JsonElement line)
    {
        try
        {
            var path = Text(line.GetProperty("path"));
            if (line.TryGetProperty("inPackage", out var held) && !held.GetBoolean()) return new ManifestFile(path, new PackageEntry.NotHeld());
            return new ManifestFile(path, line.TryGetProperty("packagePath", out var packagePath) ? new PackageEntry.HeldAt(Text(packagePath)) : new PackageEntry.Held());
        }
        catch (Exception e) when (e is InvalidOperationException or FormatException or KeyNotFoundException)
        {
            throw new InvalidDataException($"its manifest cannot be read at its file {index + 1}", e);
        }
    }

    private static string Value(Action<Utf8JsonWriter> write)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, Compact)) write(writer);
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private static void PackageLine(Utf8JsonWriter writer, ManifestPackage package, string? version)
    {
        writer.WriteStartObject();
        switch (package)
        {
            case ManifestPackage.InstallationFile installationFile:
                writer.WriteString("installationFile", installationFile.Name);
                writer.WriteNumber("size", installationFile.Size);
                writer.WriteString("hash", installationFile.Hash);
                if (installationFile.Page is { } page) writer.WriteString("page", page);
                break;
            case ManifestPackage.GameFolder gameFolder:
                writer.WriteString("gameFolder", gameFolder.Name);
                writer.WriteString("hash", gameFolder.Hash);
                break;
            case ManifestPackage.SourceMod sourceMod:
                writer.WriteString("remote", sourceMod.Remote);
                writer.WriteString("commit", sourceMod.Commit);
                break;
        }
        if (version is not null) writer.WriteString("version", version);
        writer.WriteEndObject();
    }

    private static void FileLine(Utf8JsonWriter writer, ManifestFile file)
    {
        writer.WriteStartObject();
        writer.WriteString("path", file.Path);
        switch (file.Entry)
        {
            case PackageEntry.HeldAt moved:
                writer.WriteString("packagePath", moved.Path);
                break;
            case PackageEntry.NotHeld:
                writer.WriteBoolean("inPackage", false);
                break;
        }
        writer.WriteEndObject();
    }
}
