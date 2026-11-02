using MEditService.Commands.Build;

namespace MEditService.Http.Endpoints;

internal static class PluginFileEndpoints
{
    private const string Tag = "Mods";

    public static IEndpointRouteBuilder MapPluginFileEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/plugin-files/flag-variants", PluginFileFlagVariants)
            .WithName("PluginFileFlagVariants")
            .WithTags(Tag)
            .WithDescription(
                "Reads each plugin file, by its absolute path, and answers its bytes with each combination of the game's load flags " +
                "flipped, fewest flips first: the values the flipped flags then hold, and the xxHash64 of the bytes as a manifest " +
                "carries it. A file that is no plugin is named with why.")
            .Produces<PluginFileFlagVariantsResult>()
            .ProducesProblem(400);

        app.MapPost("/plugin-files/set-flags", SetPluginFileFlags)
            .WithName("SetPluginFileFlags")
            .WithTags(Tag)
            .WithDescription(
                "Sets or clears the named load flags of each plugin file, by its absolute path, in place and changing no other byte, " +
                "and answers the hash of what it wrote. A file that is no plugin, or a name that is no load flag of the game, " +
                "leaves its file as it was and is named with why.")
            .Produces<SetPluginFileFlagsResult>()
            .ProducesProblem(400);

        return app;
    }

    internal static IResult PluginFileFlagVariants(PluginFileFlagVariantsRequest req, PluginFileFlagVariantsHandler handler, ILoggerFactory loggerFactory)
    {
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;
        return req.Paths is { Count: > 0 } paths && paths.All(path => !string.IsNullOrWhiteSpace(path))
            ? EndpointMapping.Answered(
                "Plugin file flag variants", loggerFactory.CreateLogger(nameof(PluginFileEndpoints)), handler.VariantsOf(paths, gameRelease))
            : EndpointMapping.BadRequest("At least one path is required, and every path needs a name.");
    }

    internal static IResult SetPluginFileFlags(SetPluginFileFlagsRequest req, SetPluginFileFlagsHandler handler, ILoggerFactory loggerFactory)
    {
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;
        return req.Files is { Count: > 0 } files
            && files.All(file => !string.IsNullOrWhiteSpace(file.Path) && file.Flags is { Count: > 0 })
            ? EndpointMapping.Answered(
                "Set plugin file flags", loggerFactory.CreateLogger(nameof(PluginFileEndpoints)), handler.Set(files, gameRelease))
            : EndpointMapping.BadRequest("At least one file is required, and every file needs a path and at least one flag.");
    }
}

/// <summary>The plugin files to read, and the release whose load flags they hold.</summary>
internal sealed record PluginFileFlagVariantsRequest(string GameRelease, IReadOnlyList<string> Paths);

/// <summary>The plugin files to write, and the release whose load flags they hold.</summary>
internal sealed record SetPluginFileFlagsRequest(string GameRelease, IReadOnlyList<PluginFileFlagsToSet> Files);
