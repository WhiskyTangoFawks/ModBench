using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace MEditService.ModFolderAdapter;

/// <summary>A manifest as a JSON file with a line for its version, its package and each file, the files in path order,
/// so a change to one file is one line in a diff.</summary>
internal static class ManifestText
{
    private static readonly JsonWriterOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static string Of(Manifest manifest)
    {
        List<string> members = [];
        if (manifest.Version is { } version) members.Add("\"version\": " + Value(writer => writer.WriteStringValue(version)));
        if (manifest.Package is { } package) members.Add("\"package\": " + Value(writer => PackageLine(writer, package)));
        var files = manifest.Files.OrderBy(file => file.Path, StringComparer.Ordinal).Select(file => Value(writer => FileLine(writer, file))).ToList();
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
            return new Manifest(
                root.TryGetProperty("package", out var package) ? PackageOf(package) : null,
                files,
                root.TryGetProperty("version", out var version) ? Text(version) : null);
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

    private static ManifestPackage PackageOf(JsonElement package)
    {
        if (package.TryGetProperty("installationFile", out var name))
        {
            return new ManifestPackage.InstallationFile(
                Text(name), package.GetProperty("size").GetInt64(), Text(package.GetProperty("hash")),
                package.TryGetProperty("page", out var page) ? Text(page) : null);
        }
        return new ManifestPackage.SourceMod(Text(package.GetProperty("remote")), Text(package.GetProperty("commit")));
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

    private static void PackageLine(Utf8JsonWriter writer, ManifestPackage package)
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
            case ManifestPackage.SourceMod sourceMod:
                writer.WriteString("remote", sourceMod.Remote);
                writer.WriteString("commit", sourceMod.Commit);
                break;
        }
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
