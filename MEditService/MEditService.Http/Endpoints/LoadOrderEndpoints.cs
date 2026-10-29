using System.Text.Json.Serialization;
using MEditService.Commands;
using MEditService.LoadOrder;

namespace MEditService.Http.Endpoints;

internal static class LoadOrderEndpoints
{
    private const string Tag = "LoadOrder";

    public static IEndpointRouteBuilder MapLoadOrderEndpoints(this IEndpointRouteBuilder app)
    {
        // ADR-0013. PUT, because sending the same body twice changes nothing.
        app.MapPut("/load-order", PutLoadOrder)
            .WithName("PutLoadOrder")
            .WithTags(Tag)
            .WithDescription(
                "Reconciles the load order against this snapshot (ADR-0013): every plugin file in " +
                "the instance, each with its origin, path, provider, strings files and archives, the active plugins in load order, " +
                "the plugins loaded with no line, the archives the game loads, the loose strings files it reads and the language a translated text shows in, as Mod Management decided them. " +
                "Every archive and strings file carries its stamp. " +
                "Plugins new to the snapshot are opened and " +
                "registered (indexed only if never seen), plugins absent from it are unregistered, " +
                "plugins whose load index moved are re-registered SQL-only; then one winner sweep. " +
                "Answers as soon as the snapshot is applied; the sweep runs after, reported on " +
                "GET /load-order/status and the load-order-status notification.")
            .Produces<PutLoadOrderApplied>()
            .ProducesProblem(400)
            .ProducesProblem(500);

        return app;
    }

    internal static IResult PutLoadOrder(LoadOrderRequest req, PutLoadOrderHandler handler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(LoadOrderEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received PutLoadOrder for {InstanceRoot} ({Count} plugins)", req.InstanceRoot, req.Plugins?.Count ?? 0);
        }
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;
        if (EndpointMapping.ParseStringsLanguage(req.StringsLanguage, out var stringsLanguage) is { } languageErr) return languageErr;

        if (RegisteredPluginsOf(req.Plugins) is not { } registered)
        {
            return EndpointMapping.BadRequest("Each plugin entry must have a non-empty Name, Path, Origin and Provider, and its archives and strings files.");
        }
        // Never defaulted here (ADR-0013).
        if (req.Active is not { } active || req.LoadedWithNoLine is not { } loadedWithNoLine
            || req.Archives is not { } archives || req.StringsFiles is not { } stringsFiles || !AllStamped(archives, stringsFiles)
            || req.Places is not { } places || places.Any(place => string.IsNullOrEmpty(place?.Name) || string.IsNullOrEmpty(place.Folder)))
        {
            return EndpointMapping.BadRequest("The snapshot must state its active plugins, those loaded with no line, its archives, its strings files and its places.");
        }

        var result = handler.Put(
            req.DataFolder, req.InstanceRoot, gameRelease,
            registered, active, loadedWithNoLine, archives, stringsFiles, places, stringsLanguage);
        return EndpointMapping.Answered("Put load order", logger, result);
    }

    private static bool AllStamped(IReadOnlyList<StampedFile> archives, IReadOnlyList<StampedFile> stringsFiles) =>
        archives.Concat(stringsFiles).All(file => !string.IsNullOrEmpty(file?.Path) && file.Stamp is not null);

    private static List<RegisteredPlugin>? RegisteredPluginsOf(IReadOnlyList<LoadOrderPlugin>? plugins)
    {
        if (plugins is null) return null;
        List<RegisteredPlugin> registered = [];
        foreach (var p in plugins)
        {
            if (string.IsNullOrEmpty(p.Name) || string.IsNullOrEmpty(p.Path) || string.IsNullOrEmpty(p.Origin)
                || p.Provider?.ToProvider() is not { } provider || p.Archives is not { } archives || p.StringsFiles is not { } stringsFiles
                || !AllStamped(archives, stringsFiles))
            {
                return null;
            }
            registered.Add(new RegisteredPlugin(
                p.Name, p.Origin, p.Path, provider, p.Line is { } line ? new PluginLine(line, p.LineNamesIt) : null, new PluginStrings(archives, stringsFiles)));
        }
        return registered;
    }
}

// Mod Management's snapshot (ADR-0013). InstanceRoot: one index file per instance, inside the instance root (ADR-0010).
internal sealed record LoadOrderRequest(
    IReadOnlyList<LoadOrderPlugin> Plugins, IReadOnlyList<PluginAddress> Active,
    IReadOnlyList<PluginAddress> LoadedWithNoLine, IReadOnlyList<StampedFile> Archives, IReadOnlyList<StampedFile> StringsFiles,
    IReadOnlyList<PluginPlace> Places, string DataFolder, string InstanceRoot, string GameRelease, string StringsLanguage);

internal sealed record LoadOrderPlugin(
    string Name, string Path, string Origin, PluginProviderRequest Provider, int? Line, bool LineNamesIt, IReadOnlyList<StampedFile> Archives,
    IReadOnlyList<StampedFile> StringsFiles);

[JsonConverter(typeof(JsonStringEnumConverter))]
internal enum PluginProviderKind { Mod, Game, None }

internal sealed record PluginProviderRequest(PluginProviderKind Kind, string? Mod = null, string? Folder = null, string? SourceFolder = null)
{
    internal PluginProvider? ToProvider() => Kind switch
    {
        PluginProviderKind.Game when Mod is null && Folder is null && SourceFolder is null => PluginProvider.Game,
        PluginProviderKind.None when Mod is null && Folder is null && SourceFolder is null => PluginProvider.NoMod,
        PluginProviderKind.Mod when !string.IsNullOrEmpty(Mod) && !string.IsNullOrEmpty(Folder) && SourceFolder is null or { Length: > 0 } =>
            new PluginProvider.FromMod(Mod, Folder, SourceFolder),
        _ => null,
    };
}
