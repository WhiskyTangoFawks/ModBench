using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MEditService.SourceAdapter;

/// <summary>A change to a source mod's build configuration: the output folder's new name, and the paths in the mod
/// folder to exclude from its build or include again.</summary>
public sealed record BuildConfigurationChange(string? Output, IReadOnlyList<string> Exclude, IReadOnlyList<string> Include);

/// <summary>A source mod's build configuration: the mod folder its build writes, by name, and the paths in it the
/// build excludes. The mod manager's record says the installation files.</summary>
internal static class BuildConfiguration
{
    private const string OutputKey = "output";
    private const string ExcludeKey = "exclude";

    private static readonly JsonSerializerOptions Spelling = new()
    {
        WriteIndented = true,
        NewLine = "\n",
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static byte[] Of(string output) => Spelled(new JsonObject { [OutputKey] = output });

    /// <summary>Writes <paramref name="change"/> into the folder's configuration, keeping all else it says. Nothing is
    /// committed (ADR-0007).</summary>
    internal static void Change(string sourceFolder, BuildConfigurationChange change)
    {
        var path = Path.Combine(sourceFolder, SourceRepositoryLayout.BuildConfigurationFileName);
        if (!File.Exists(path)) throw SourceStopException.Unreadable($"'{sourceFolder}' holds no build configuration.");
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
        return [.. paths.Select(p => p is JsonValue value && value.TryGetValue<string>(out var path) ? path : throw notPaths)];
    }

    private static SourceStopException Unreadable(string sourceFolder, string because) =>
        SourceStopException.Unreadable($"The build configuration in '{sourceFolder}' cannot be read: {because}.");

    private static byte[] Spelled(JsonObject configuration) =>
        [.. System.Text.Encoding.UTF8.GetBytes(configuration.ToJsonString(Spelling)), (byte)'\n'];
}
