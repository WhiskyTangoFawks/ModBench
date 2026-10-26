using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace MEditService.ModFolderAdapter;

/// <summary>A manifest as a JSON file with a line for its output, its package and version, its exclusions, each archive,
/// and each file in alphabetical order, so a change to one file is one line in a diff.</summary>
internal static class ManifestText
{
    private const string OutputKey = "output";

    private static readonly JsonWriterOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static string Of(Manifest manifest)
    {
        List<string> members = [];
        if (manifest.Output is { } output) members.Add($"\"{OutputKey}\": " + Value(writer => writer.WriteStringValue(output)));
        if (manifest.Package is not null) members.Add("\"package\": " + Value(writer => PackageLine(writer, manifest.Package, manifest.Version)));
        if (manifest.Exclude.Count > 0)
            members.Add("\"exclude\": " + Value(writer => Paths(writer, manifest.Exclude.Order(StringComparer.OrdinalIgnoreCase).ThenBy(path => path, StringComparer.Ordinal))));
        if (manifest.Archives.Count > 0)
        {
            var archives = manifest.Archives.Select(archive => Value(writer => writer.WriteStringValue(archive.Path)) + ": " + Value(writer => Paths(writer, archive.Files)));
            members.Add("\"archives\": {\n" + string.Join(",\n", archives) + "\n}");
        }
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
            var root = Known(parsed.RootElement, "its manifest", OutputKey, "package", "exclude", "archives", "files");
            var files = root.GetProperty("files").EnumerateArray().Index().Select(entry => FileOf(entry.Index, entry.Item)).ToList();
            var (package, version) = root.TryGetProperty("package", out var line) ? PackageOf(line) : (null, null);
            return new Manifest(package, files, version) { Output = OutputOf(root), Exclude = ExclusionsOf(root), Archives = ArchivesOf(root) };
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

    // modlist-repository.md, The manifest: a key no member reads would be dropped by the next write, so it refuses the read.
    private static JsonElement Known(JsonElement line, string where, params string[] keys) =>
        line.EnumerateObject().Select(member => member.Name).FirstOrDefault(name => !keys.Contains(name, StringComparer.Ordinal)) is { } unknown
            ? throw new InvalidDataException($"{where} holds '{unknown}', which Modbench does not read")
            : line;

    private static string? OutputOf(JsonElement root)
    {
        if (!root.TryGetProperty(OutputKey, out var named)) return null;
        var output = Text(named);
        return Manifest.IsFolderName(output) ? output : throw new InvalidDataException($"its manifest's output '{output}' is not a folder name");
    }

    private static List<string> ExclusionsOf(JsonElement root) =>
        root.TryGetProperty("exclude", out var paths) ? InTheFolder("exclude", PathsOf(paths)) : [];

    private static List<ManifestArchive> ArchivesOf(JsonElement root)
    {
        if (!root.TryGetProperty("archives", out var archives)) return [];
        List<ManifestArchive> packed = [.. archives.EnumerateObject().Select(archive => new ManifestArchive(archive.Name, PathsOf(archive.Value)))];
        InTheFolder("archives", [.. packed.Select(archive => archive.Path), .. packed.SelectMany(archive => archive.Files)]);
        return packed;
    }

    private static List<string> PathsOf(JsonElement paths) => [.. paths.EnumerateArray().Select(Text)];

    private static List<string> InTheFolder(string key, List<string> paths) =>
        paths.FirstOrDefault(path => !Manifest.IsPathInTheFolder(path)) is { } outside
            ? throw new InvalidDataException($"its manifest's '{key}' names '{outside}', which is not a path in the folder")
            : paths;

    private static void Paths(Utf8JsonWriter writer, IEnumerable<string> paths)
    {
        writer.WriteStartArray();
        foreach (var path in paths) writer.WriteStringValue(path);
        writer.WriteEndArray();
    }

    private static (ManifestPackage Package, string? Version) PackageOf(JsonElement line)
    {
        Known(line, "its manifest's package", "installationFile", "size", "hash", "page", "gameFolder", "submodule", "repository", "version");
        var version = line.TryGetProperty("version", out var held) ? Text(held) : null;
        if (line.TryGetProperty("installationFile", out var name))
        {
            return (new ManifestPackage.InstallationFile(
                Text(name), line.GetProperty("size").GetInt64(), Text(line.GetProperty("hash")),
                line.TryGetProperty("page", out var page) ? Text(page) : null), version);
        }
        if (line.TryGetProperty("gameFolder", out var game)) return (new ManifestPackage.GameFolder(Text(game), Text(line.GetProperty("hash"))), version);
        if (line.TryGetProperty("submodule", out var submodule)) return (new ManifestPackage.SourceRepository(Text(submodule), IsSubmodule: true), version);
        return (new ManifestPackage.SourceRepository(Text(line.GetProperty("repository")), IsSubmodule: false), version);
    }

    private static ManifestFile FileOf(int index, JsonElement line)
    {
        try
        {
            Known(line, $"its manifest's file {index + 1}", "path", "packagePath", "inPackage", "otherBytes");
            var path = Text(line.GetProperty("path"));
            var notHeld = FlagOf(index, line, "inPackage", written: false);
            var otherBytes = FlagOf(index, line, "otherBytes", written: true);
            var movedTo = line.TryGetProperty("packagePath", out var packagePath) ? Text(packagePath) : null;
            if (notHeld && otherBytes) throw Unreadable(index, "it says both that its package does not hold the file and that it holds it with other bytes");
            if ((notHeld || otherBytes) && movedTo is not null) throw Unreadable(index, "it names a path in its package for a file its package does not hold with its bytes");
            if (notHeld) return new ManifestFile(path, new PackageEntry.NotHeld());
            if (otherBytes) return new ManifestFile(path, new PackageEntry.OtherBytes());
            return new ManifestFile(path, movedTo is null ? new PackageEntry.Held() : new PackageEntry.HeldAt(movedTo));
        }
        catch (Exception e) when (e is InvalidOperationException or FormatException or KeyNotFoundException)
        {
            throw new InvalidDataException($"its manifest cannot be read at its file {index + 1}", e);
        }
    }

    // A flag is written only as its one value, and read only as that.
    private static bool FlagOf(int index, JsonElement line, string key, bool written)
    {
        if (!line.TryGetProperty(key, out var flag)) return false;
        if (flag.GetBoolean() != written) throw Unreadable(index, $"its {key} is {(written ? "false" : "true")}");
        return true;
    }

    private static InvalidDataException Unreadable(int index, string why) => new($"its manifest cannot be read at its file {index + 1}: {why}");

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
            case ManifestPackage.SourceRepository repository:
                writer.WriteString(repository.IsSubmodule ? "submodule" : "repository", repository.Name);
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
            case PackageEntry.OtherBytes:
                writer.WriteBoolean("otherBytes", true);
                break;
        }
        writer.WriteEndObject();
    }
}
