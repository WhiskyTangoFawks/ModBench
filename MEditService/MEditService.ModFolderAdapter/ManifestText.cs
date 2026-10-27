using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace MEditService.ModFolderAdapter;

/// <summary>A manifest as a JSON file with a line for each part, each step in the order they run, each tool, and each
/// file in alphabetical order, so a changed file is one line in a diff.</summary>
internal static class ManifestText
{
    private const string OutputKey = "output";

    private static readonly JsonWriterOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static string Of(Manifest manifest)
    {
        List<string> members = [];
        if (manifest.Output is { } output) members.Add($"\"{OutputKey}\": " + Value(writer => writer.WriteStringValue(output)));
        if (manifest.Packages.Count > 0)
        {
            var lines = manifest.Packages.Select((package, index) => Value(writer => PackageLine(writer, package, index == 0 ? manifest.Version : null)));
            members.Add("\"packages\": [\n" + string.Join(",\n", lines) + "\n]");
        }
        if (manifest.Exclude.Count > 0)
            members.Add("\"exclude\": " + Value(writer => Strings(writer, manifest.Exclude.Order(StringComparer.OrdinalIgnoreCase).ThenBy(path => path, StringComparer.Ordinal))));
        if (manifest.Archives.Count > 0)
        {
            var archives = manifest.Archives.Select(archive => Value(writer => writer.WriteStringValue(archive.Path)) + ": " + Value(writer => Strings(writer, archive.Files)));
            members.Add("\"archives\": {\n" + string.Join(",\n", archives) + "\n}");
        }
        if (manifest.Steps.Count > 0) members.Add("\"steps\": [\n" + string.Join(",\n", manifest.Steps.Select(step => Value(writer => StepLine(writer, step)))) + "\n]");
        if (manifest.Tools.Count > 0) members.Add("\"tools\": [\n" + string.Join(",\n", manifest.Tools.Select(tool => Value(writer => ToolLine(writer, tool)))) + "\n]");
        var files = manifest.Files.OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase).ThenBy(file => file.Path, StringComparer.Ordinal).Select(file => Value(writer => FileLine(writer, file, manifest.Package is { } first ? Manifest.NameOf(first) : null))).ToList();
        members.Add(files.Count == 0 ? "\"files\": []" : "\"files\": [\n" + string.Join(",\n", files) + "\n]");
        return "{\n" + string.Join(",\n", members) + "\n}\n";
    }

    /// <summary>The manifest Of wrote. Throws <see cref="InvalidDataException"/> naming where it cannot read it.</summary>
    public static Manifest Parse(string text)
    {
        try
        {
            using var parsed = JsonDocument.Parse(text);
            var root = Known(parsed.RootElement, "its manifest", OutputKey, "packages", "exclude", "archives", "steps", "tools", "files");
            var files = root.GetProperty("files").EnumerateArray().Index().Select(entry => FileOf(entry.Index, entry.Item)).ToList();
            List<ManifestStep> steps = root.TryGetProperty("steps", out var held) ? [.. held.EnumerateArray().Index().Select(entry => StepOf(entry.Index, entry.Item))] : [];
            List<ManifestTool> tools = root.TryGetProperty("tools", out var named) ? [.. named.EnumerateArray().Index().Select(entry => ToolOf(entry.Index, entry.Item))] : [];
            var (packages, version) = root.TryGetProperty("packages", out var line) ? PackagesOf(line) : ([], null);
            if (files.FindIndex(file => file.Package is { } named && packages.All(package => Manifest.NameOf(package) != named)) is var unnamed and >= 0)
                throw Unreadable(unnamed, "it names a package the manifest does not name");
            if (steps.Count == 0 && files.FindIndex(file => file.Entry is PackageEntry.MadeByStep) is var madeByStep and >= 0)
                throw Unreadable(madeByStep, "it says a step makes the file, and the manifest holds no step");
            return new Manifest(packages, files, version) { Output = OutputOf(root), Exclude = ExclusionsOf(root), Archives = ArchivesOf(root), Steps = steps, Tools = tools };
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
        root.TryGetProperty("exclude", out var paths) ? InTheFolder("exclude", StringsOf(paths)) : [];

    private static List<ManifestArchive> ArchivesOf(JsonElement root)
    {
        if (!root.TryGetProperty("archives", out var archives)) return [];
        List<ManifestArchive> packed = [.. archives.EnumerateObject().Select(archive => new ManifestArchive(archive.Name, StringsOf(archive.Value)))];
        InTheFolder("archives", [.. packed.Select(archive => archive.Path), .. packed.SelectMany(archive => archive.Files)]);
        return packed;
    }

    private static List<string> StringsOf(JsonElement strings) => [.. strings.EnumerateArray().Select(Text)];

    private static List<string> InTheFolder(string key, List<string> paths) =>
        paths.FirstOrDefault(path => !Manifest.IsPathInTheFolder(path)) is { } outside
            ? throw new InvalidDataException($"its manifest's '{key}' names '{outside}', which is not a path in the folder")
            : paths;

    private static void Strings(Utf8JsonWriter writer, IEnumerable<string> strings)
    {
        writer.WriteStartArray();
        foreach (var text in strings) writer.WriteStringValue(text);
        writer.WriteEndArray();
    }

    // The mod's version rides the first package's line.
    private static (List<ManifestPackage> Packages, string? Version) PackagesOf(JsonElement lines)
    {
        List<ManifestPackage> packages = [];
        string? version = null;
        foreach (var (index, line) in lines.EnumerateArray().Index())
        {
            var (package, held) = PackageOf(index, line);
            if (packages.Any(other => Manifest.NameOf(other) == Manifest.NameOf(package)))
                throw new InvalidDataException($"its manifest names the package '{Manifest.NameOf(package)}' twice");
            packages.Add(package);
            if (index == 0) version = held;
        }
        return (packages, version);
    }

    private static (ManifestPackage Package, string? Version) PackageOf(int index, JsonElement line)
    {
        try
        {
            Known(line, $"its manifest's package {index + 1}", "installationFile", "size", "hash", "page", "gameFolder", "submodule", "repository", "version");
            var version = line.TryGetProperty("version", out var held) ? Text(held) : null;
            if (version is not null && index > 0) throw new InvalidDataException($"its manifest's package {index + 1} holds a version, which belongs to the first package");
            if (line.TryGetProperty("installationFile", out _)) return (InstallationFileIn(line), version);
            if (line.TryGetProperty("gameFolder", out var game)) return (new ManifestPackage.GameFolder(Text(game), Text(line.GetProperty("hash"))), version);
            if (line.TryGetProperty("submodule", out var submodule)) return (new ManifestPackage.SourceRepository(Text(submodule), IsSubmodule: true), version);
            return (new ManifestPackage.SourceRepository(Text(line.GetProperty("repository")), IsSubmodule: false), version);
        }
        catch (Exception e) when (e is InvalidOperationException or FormatException or KeyNotFoundException)
        {
            throw new InvalidDataException($"its manifest cannot be read at its package {index + 1}", e);
        }
    }

    private static ManifestPackage.InstallationFile InstallationFileIn(JsonElement line) =>
        new(Text(line.GetProperty("installationFile")), line.GetProperty("size").GetInt64(), Text(line.GetProperty("hash")),
            line.TryGetProperty("page", out var page) ? Text(page) : null);

    private static ManifestStep StepOf(int index, JsonElement line)
    {
        try
        {
            Known(line, $"its manifest's step {index + 1}", "task", "args");
            var task = Text(line.GetProperty("task"));
            if (string.IsNullOrWhiteSpace(task)) throw new InvalidDataException($"its manifest cannot be read at its step {index + 1}: it names no task");
            return new ManifestStep(task, line.TryGetProperty("args", out var args) ? StringsOf(args) : []);
        }
        catch (Exception e) when (e is InvalidOperationException or FormatException or KeyNotFoundException)
        {
            throw new InvalidDataException($"its manifest cannot be read at its step {index + 1}", e);
        }
    }

    private static ManifestTool ToolOf(int index, JsonElement line)
    {
        try
        {
            Known(line, $"its manifest's tool {index + 1}", "task", "page");
            var (task, page) = (Text(line.GetProperty("task")), Text(line.GetProperty("page")));
            if (string.IsNullOrWhiteSpace(task)) throw new InvalidDataException($"its manifest cannot be read at its tool {index + 1}: it names no task");
            if (string.IsNullOrWhiteSpace(page)) throw new InvalidDataException($"its manifest cannot be read at its tool {index + 1}: it names no page");
            return new ManifestTool(task, page);
        }
        catch (Exception e) when (e is InvalidOperationException or FormatException or KeyNotFoundException)
        {
            throw new InvalidDataException($"its manifest cannot be read at its tool {index + 1}", e);
        }
    }

    private static ManifestFile FileOf(int index, JsonElement line)
    {
        try
        {
            Known(line, $"its manifest's file {index + 1}", "path", "package", "packagePath", "inPackage", "otherBytes", "madeByStep");
            var path = Text(line.GetProperty("path"));
            var says = new (bool Set, string Says, PackageEntry Entry)[]
            {
                (FlagOf(index, line, "inPackage", written: false), "its package does not hold the file", new PackageEntry.NotHeld()),
                (FlagOf(index, line, "otherBytes", written: true), "its package holds it with other bytes", new PackageEntry.OtherBytes()),
                (FlagOf(index, line, "madeByStep", written: true), "a step makes it", new PackageEntry.MadeByStep()),
            }.Where(flag => flag.Set).ToList();
            var movedTo = line.TryGetProperty("packagePath", out var packagePath) ? Text(packagePath) : null;
            var package = line.TryGetProperty("package", out var named) ? Text(named) : null;
            if (says is [var one, var other, ..]) throw Unreadable(index, $"it says both that {one.Says} and that {other.Says}");
            if (says.Count > 0 && movedTo is not null) throw Unreadable(index, "it names a path in its package for a file its package does not hold with its bytes");
            if (says is [var only])
            {
                if (only.Entry is PackageEntry.MadeByStep && package is not null) throw Unreadable(index, "it names a package for a file a step makes");
                return new ManifestFile(path, only.Entry, package);
            }
            return new ManifestFile(path, movedTo is null ? new PackageEntry.Held() : new PackageEntry.HeldAt(movedTo), package);
        }
        catch (Exception e) when (e is InvalidOperationException or FormatException or KeyNotFoundException)
        {
            throw new InvalidDataException($"its manifest cannot be read at its file {index + 1}", e);
        }
    }

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
                InstallationFileMembers(writer, installationFile);
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

    private static void InstallationFileMembers(Utf8JsonWriter writer, ManifestPackage.InstallationFile installationFile)
    {
        writer.WriteString("installationFile", installationFile.Name);
        writer.WriteNumber("size", installationFile.Size);
        writer.WriteString("hash", installationFile.Hash);
        if (installationFile.Page is { } page) writer.WriteString("page", page);
    }

    private static void StepLine(Utf8JsonWriter writer, ManifestStep step)
    {
        writer.WriteStartObject();
        writer.WriteString("task", step.Task);
        if (step.Args.Count > 0)
        {
            writer.WritePropertyName("args");
            Strings(writer, step.Args);
        }
        writer.WriteEndObject();
    }

    private static void ToolLine(Utf8JsonWriter writer, ManifestTool tool)
    {
        writer.WriteStartObject();
        writer.WriteString("task", tool.Task);
        writer.WriteString("page", tool.Page);
        writer.WriteEndObject();
    }

    private static void FileLine(Utf8JsonWriter writer, ManifestFile file, string? first)
    {
        writer.WriteStartObject();
        writer.WriteString("path", file.Path);
        if (file.Package is { } package && package != first) writer.WriteString("package", package);
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
            case PackageEntry.MadeByStep:
                writer.WriteBoolean("madeByStep", true);
                break;
        }
        writer.WriteEndObject();
    }
}
