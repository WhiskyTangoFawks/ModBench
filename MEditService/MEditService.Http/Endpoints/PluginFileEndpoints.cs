using MEditService.Commands;

namespace MEditService.Http.Endpoints;

internal static class PluginFileEndpoints
{
    private const string Tag = "Mods";

    public static IEndpointRouteBuilder MapPluginFileEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/plugin-files/set-flags", SetPluginFileFlags)
            .WithName("SetPluginFileFlags")
            .WithTags(Tag)
            .WithDescription(
                "Sets or clears the named load flags of each plugin file, by its absolute path, in place and changing no other byte, " +
                "and answers the hash of what it wrote. A file that is no plugin, a name that is no load flag of the game, " +
                "or a light or medium flag whose FormID range the plugin's records exceed leaves its file as it was and is named with why.")
            .Produces<SetPluginFileFlagsResult>()
            .ProducesProblem(400);

        return app;
    }

    internal static async Task<IResult> SetPluginFileFlags(
        SetPluginFileFlagsRequest req, SetPluginFileFlagsHandler handler, ILoggerFactory loggerFactory, CancellationToken cancel)
    {
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;
        return req.Files is { Count: > 0 } files
            && files.All(file => !string.IsNullOrWhiteSpace(file.Path) && file.Flags is { Count: > 0 })
            ? EndpointMapping.Answered(
                "Set plugin file flags", loggerFactory.CreateLogger(nameof(PluginFileEndpoints)), await handler.Set(files, gameRelease, cancel))
            : EndpointMapping.BadRequest("At least one file is required, and every file needs a path and at least one flag.");
    }
}

/// <summary>The plugin files to write, and the release whose load flags they hold.</summary>
internal sealed record SetPluginFileFlagsRequest(string GameRelease, IReadOnlyList<PluginFileFlagsToSet> Files);
