using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MEditService.SourceAdapter;

/// <summary>A change to a source mod's build configuration: the output folder's new name, and the paths in the mod
/// folder to exclude from its build or include again.</summary>
public sealed record BuildConfigurationChange(string? Output, IReadOnlyList<string> Exclude, IReadOnlyList<string> Include);

/// <summary>A file of the base: the installation file named <paramref name="InstallationFile"/> provides it at
/// <paramref name="Path"/> in the mod folder from its entry at <paramref name="Entry"/>.</summary>
public sealed record BaseFile(string Path, string InstallationFile, string Entry);

/// <summary>An archive to pack at <paramref name="Path"/> in the mod folder from the files of the build at
/// <paramref name="Files"/>.</summary>
public sealed record ArchiveToPack(string Path, IReadOnlyList<string> Files);

/// <summary>What a source mod's build writes, as its working tree says: the output folder's name, its exclusions, the
/// base, each archive to pack, the plugins its plugin source holds and its assets.</summary>
public sealed record SourceToBuild(
    string Output, IReadOnlyList<string> Exclude, IReadOnlyList<BaseFile> Base, IReadOnlyList<ArchiveToPack> Archives,
    IReadOnlyList<string> Plugins, IReadOnlyList<Asset> Assets);

/// <summary>A source mod's build configuration: the output folder's name, its exclusions, the base by installation file
/// name and entry, and each archive to pack. The mod manager's record says where each installation file is.</summary>
internal static class BuildConfiguration
{
    private const string OutputKey = "output";
    private const string ExcludeKey = "exclude";
    private const string BaseKey = "base";
    private const string ArchivesKey = "archives";

    private static readonly JsonSerializerOptions Spelling = new()
    {
        WriteIndented = true,
        NewLine = "\n",
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static byte[] Of(string output, IReadOnlyList<BaseFile> baseFiles)
    {
        var configuration = new JsonObject { [OutputKey] = output };
        if (baseFiles.Count > 0)
        {
            configuration[BaseKey] = new JsonObject(baseFiles
                .GroupBy(file => file.InstallationFile, StringComparer.Ordinal)
                .OrderBy(file => file.Key, StringComparer.OrdinalIgnoreCase)
                .Select(installed => KeyValuePair.Create<string, JsonNode?>(installed.Key, new JsonObject(installed
                    .OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase)
                    .Select(file => KeyValuePair.Create<string, JsonNode?>(file.Path, file.Entry))))));
        }

        return Spelled(configuration);
    }

    internal static SourceToBuild ToBuild(string sourceFolder)
    {
        var configuration = Read(sourceFolder, File.ReadAllBytes(PathIn(sourceFolder)));
        if (configuration[OutputKey] is not JsonValue named || !named.TryGetValue<string>(out var output))
            throw Unreadable(sourceFolder, "it names no output");
        if (!IsPathInTheMod(output) || output.Contains('/', StringComparison.Ordinal))
            throw Unreadable(sourceFolder, $"its output '{output}' is not a folder name");

        return new SourceToBuild(
            output,
            InTheMod(sourceFolder, ExcludeKey, ExclusionsIn(sourceFolder, configuration)),
            BaseIn(sourceFolder, configuration),
            ArchivesIn(sourceFolder, configuration),
            SourceRepositoryLayout.PluginsIn(sourceFolder),
            AssetsIn(sourceFolder));
    }

    private static IReadOnlyList<Asset> AssetsIn(string sourceFolder)
    {
        var assets = SourceRepositoryLayout.AssetsIn(sourceFolder);
        if (assets.GroupBy(asset => asset.Path, StringComparer.OrdinalIgnoreCase).FirstOrDefault(paths => paths.Count() > 1) is { } twins)
        {
            throw SourceStopException.Unreadable(
                $"'{Path.Combine(sourceFolder, SourceRepositoryLayout.AssetsFolderName)}' holds {string.Join(" and ", twins.Select(twin => $"'{twin.Path}'"))}, " +
                "which differ only in case: one mod folder cannot hold both on Windows.");
        }

        return assets;
    }

    /// <summary>Writes <paramref name="change"/> into the folder's configuration, keeping all else it says. Nothing is
    /// committed (ADR-0007).</summary>
    internal static void Change(string sourceFolder, BuildConfigurationChange change)
    {
        var path = PathIn(sourceFolder);
        var configuration = Read(sourceFolder, File.ReadAllBytes(path));
        var excluded = ExclusionsIn(sourceFolder, configuration);
        if (change.Output is { } output) configuration[OutputKey] = output;
        if (change.Exclude.Count + change.Include.Count > 0)
        {
            excluded.RemoveAll(kept => change.Include.Contains(kept, StringComparer.OrdinalIgnoreCase));
            excluded.AddRange(change.Exclude.Where(added => !excluded.Contains(added, StringComparer.OrdinalIgnoreCase)));
            configuration.Remove(ExcludeKey);
            if (excluded.Count > 0)
                configuration[ExcludeKey] = new JsonArray([.. excluded.Order(StringComparer.OrdinalIgnoreCase).Select(p => JsonValue.Create(p))]);
        }

        new WriteJournal(sourceFolder).Write(path, Spelled(configuration));
    }

    /// <summary>A forward-slash path that stays inside the mod folder.</summary>
    internal static bool IsPathInTheMod(string path) =>
        !path.Contains('\\', StringComparison.Ordinal) && !Path.IsPathRooted(path)
        && path.Split('/').All(segment => !string.IsNullOrWhiteSpace(segment) && segment is not ("." or ".."));

    private static string PathIn(string sourceFolder)
    {
        var path = Path.Combine(sourceFolder, SourceRepositoryLayout.BuildConfigurationFileName);
        return File.Exists(path) ? path : throw SourceStopException.Unreadable($"'{sourceFolder}' holds no build configuration.");
    }

    private static List<string> InTheMod(string sourceFolder, string key, List<string> paths) =>
        paths.FirstOrDefault(path => !IsPathInTheMod(path)) is { } outside
            ? throw Unreadable(sourceFolder, $"its '{key}' names '{outside}', which is not a path in the mod folder")
            : paths;

    private static List<BaseFile> BaseIn(string sourceFolder, JsonObject configuration)
    {
        if (configuration[BaseKey] is null) return [];
        var notBase = Unreadable(sourceFolder, $"its '{BaseKey}' is not each installation file's paths with their entries");
        if (configuration[BaseKey] is not JsonObject installed) throw notBase;
        List<BaseFile> files =
        [
            .. installed.SelectMany(file => file.Value is JsonObject paths
                ? paths.Select(path => new BaseFile(path.Key, file.Key, StringIn(path.Value) ?? throw notBase))
                : throw notBase),
        ];
        InTheMod(sourceFolder, BaseKey, [.. files.Select(file => file.Path)]);
        return files;
    }

    private static List<ArchiveToPack> ArchivesIn(string sourceFolder, JsonObject configuration)
    {
        if (configuration[ArchivesKey] is null) return [];
        var notArchives = Unreadable(sourceFolder, $"its '{ArchivesKey}' is not each archive's paths");
        if (configuration[ArchivesKey] is not JsonObject archives) throw notArchives;
        List<ArchiveToPack> packed =
        [
            .. archives.Select(archive => archive.Value is JsonArray files
                ? new ArchiveToPack(archive.Key, [.. files.Select(file => StringIn(file) ?? throw notArchives)])
                : throw notArchives),
        ];
        InTheMod(sourceFolder, ArchivesKey, [.. packed.Select(archive => archive.Path)]);
        InTheMod(sourceFolder, ArchivesKey, [.. packed.SelectMany(archive => archive.Files)]);
        return packed;
    }

    private static string? StringIn(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static JsonObject Read(string sourceFolder, byte[] bytes)
    {
        try
        {
            return JsonNode.Parse(bytes) as JsonObject ?? throw Unreadable(sourceFolder, "it is not a JSON object");
        }
        catch (JsonException ex)
        {
            throw Unreadable(sourceFolder, ex.Message);
        }
    }

    private static List<string> ExclusionsIn(string sourceFolder, JsonObject configuration)
    {
        if (configuration[ExcludeKey] is null) return [];
        var notPaths = Unreadable(sourceFolder, $"its '{ExcludeKey}' is not a list of paths");
        if (configuration[ExcludeKey] is not JsonArray paths) throw notPaths;
        return [.. paths.Select(p => StringIn(p) ?? throw notPaths)];
    }

    private static SourceStopException Unreadable(string sourceFolder, string because) =>
        SourceStopException.Unreadable($"The build configuration in '{sourceFolder}' cannot be read: {because}.");

    private static byte[] Spelled(JsonObject configuration) =>
        [.. System.Text.Encoding.UTF8.GetBytes(configuration.ToJsonString(Spelling)), (byte)'\n'];
}
