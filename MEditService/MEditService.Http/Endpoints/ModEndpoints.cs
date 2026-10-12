using MEditService.Commands.Build;

namespace MEditService.Http.Endpoints;

internal static class ModEndpoints
{
    public static IEndpointRouteBuilder MapModEndpoints(this IEndpointRouteBuilder app)
    {
        // A missing load order or git refuses the whole selection once; every other refusal is an item of
        // the answer.
        app.MapPost("/mods/build", Build)
            .WithName("BuildMod")
            .WithTags("Mods")
            .Produces<BuildResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        return app;
    }

    // build-mod: the selection (commands.md, A selection is one gesture).
    internal static async Task<IResult> Build(BuildRequest req, BuildHandler buildHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(ModEndpoints));
        var mods = req.Mods ?? [];
        if (mods.Count == 0)
            return Results.Problem("At least one mod is required.", statusCode: 400);
        if (mods.Any(string.IsNullOrWhiteSpace))
            return Results.Problem("Every mod needs a name.", statusCode: 400);

        return await EndpointMapping.Answered(
            "Build", logger,
            buildHandler.BuildAsync(mods),
            EndpointMapping.Refusal,
            landed => new BuiltModResponse(
                landed.Item,
                [.. landed.Outcome.Compiled.Select(c => new CompiledPlugin(c.Item.Name, c.Item.Origin, c.Outcome))],
                [.. landed.Outcome.Refused.Select(r => new PluginCompileRefusal(r.Item, r.Refusal, r.Message))]),
            refused => new ModBuildRefusal(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new BuildResponse(applied, refused));
    }
}

/// <summary>The mods by name; the load order says each one's plugins.</summary>
internal sealed record BuildRequest(IReadOnlyList<string> Mods);

/// <summary>A mod of the selection that built: the plugins that compiled, and the plugins refused, which
/// stay as they were.</summary>
internal sealed record BuiltModResponse(
    string Mod, IReadOnlyList<CompiledPlugin> Compiled, IReadOnlyList<PluginCompileRefusal> Refused);

/// <summary>A mod of the selection that wrote nothing: the typed refusal, and the message naming the
/// way out.</summary>
internal sealed record ModBuildRefusal(string Item, BuildRefusal Refusal, string Message);

/// <summary>Applied or refusal, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record BuildResponse(IReadOnlyList<BuiltModResponse> Applied, IReadOnlyList<ModBuildRefusal> Refused);
