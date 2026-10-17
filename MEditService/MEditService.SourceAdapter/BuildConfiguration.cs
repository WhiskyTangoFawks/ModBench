using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MEditService.SourceAdapter;

/// <summary>A change to a source mod's build configuration: the output folder's new name, and the paths in the mod
/// folder to exclude from its build or include again.</summary>
public sealed record BuildConfigurationChange(string? Output, IReadOnlyList<string> Exclude, IReadOnlyList<string> Include);

/// <summary>An archive to pack at <paramref name="Path"/> in the mod folder from the files of the build at
/// <paramref name="Files"/>.</summary>
public sealed record ArchiveToPack(string Path, IReadOnlyList<string> Files);

/// <summary>What a source mod's build writes over the base, as its working tree says. Uncommitted: its working tree holds
/// changes no commit holds. Unpushed: its remote, as last fetched, lacks HEAD.</summary>
public sealed record SourceToBuild(
    string Output, IReadOnlyList<string> Exclude, IReadOnlyList<ArchiveToPack> Archives, IReadOnlyList<string> Plugins,
    IReadOnlyList<Asset> Assets, bool Uncommitted = false, bool Unpushed = false);

/// <summary>A source mod's repository as the instance repository holds it: the folder git checks it out in, the commit the
/// instance repository pins, and the branch it follows, if any.</summary>
public sealed record Submodule(string Folder, string Pin, string? Branch);

/// <summary>The commit a submodule's repository is at, and why the clone that made it was left detached at the pin.</summary>
public sealed record SubmoduleHead(string Commit, string? LeftDetached = null);

/// <summary>A source mod's build configuration: the output folder's name, its exclusions and each archive to pack. The
/// mod manager's record says the installation files.</summary>
internal static class BuildConfiguration
{
    private const string OutputKey = "output";
    private const string ExcludeKey = "exclude";
    private const string ArchivesKey = "archives";

    private static readonly JsonSerializerOptions Spelling = new()
    {
        WriteIndented = true,
        NewLine = "\n",
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static byte[] Of(string output) => Spelled(new JsonObject { [OutputKey] = output });

    internal static SourceToBuild ToBuild(string sourceFolder)
    {
        var configuration = Read(sourceFolder, File.ReadAllBytes(PathIn(sourceFolder)));
        if (configuration[OutputKey] is not JsonValue named || !named.TryGetValue<string>(out var output))
            throw Unreadable(sourceFolder, "it names no output");
        if (!IsFolderName(output))
            throw Unreadable(sourceFolder, $"its output '{output}' is not a folder name");

        var remote = Submodules.RemoteOf(sourceFolder);
        return new SourceToBuild(
            output,
            InTheMod(sourceFolder, ExcludeKey, ExclusionsIn(sourceFolder, configuration)),
            ArchivesIn(sourceFolder, configuration),
            SourceRepositoryLayout.PluginsIn(sourceFolder),
            AssetsIn(sourceFolder),
            remote?.Uncommitted ?? false,
            remote?.Unpushed ?? false);
    }

    private static IReadOnlyList<Asset> AssetsIn(string sourceFolder)
    {
        var assets = SourceRepositoryLayout.AssetsIn(sourceFolder);
        if (TwinsIn(assets.Select(asset => asset.Path)) is { } twins)
            throw SourceStopException.Unreadable($"'{Path.Combine(sourceFolder, SourceRepositoryLayout.AssetsFolderName)}' holds {twins}.");
        return assets;
    }

    private static string? TwinsIn(IEnumerable<string> paths) =>
        paths.GroupBy(path => path, StringComparer.OrdinalIgnoreCase).FirstOrDefault(same => same.Count() > 1) is { } twins
            ? $"{string.Join(" and ", twins.Select(twin => $"'{twin}'"))}, which differ only in case: one mod folder cannot hold both on Windows"
            : null;

    /// <summary>Writes <paramref name="change"/> into the folder's configuration, keeping all else it says. Nothing is
    /// committed (ADR-0007).</summary>
    internal static void Change(string sourceFolder, BuildConfigurationChange change)
    {
        if (change.Output is { } named && !IsFolderName(named))
            throw SourceStopException.OutsideTheMod($"The output '{named}' is not a folder name.");
        if (change.Exclude.Concat(change.Include).FirstOrDefault(path => !IsPathInTheMod(path)) is { } outside)
            throw SourceStopException.OutsideTheMod($"'{outside}' is not a path in the mod folder.");

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

    private static bool IsFolderName(string name) => IsPathInTheMod(name) && !name.Contains('/', StringComparison.Ordinal);

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
