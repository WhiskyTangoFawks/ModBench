using MEditService.Commands.Build;
using MEditService.LoadOrder;

namespace MEditService.Http.Endpoints;

internal static class ModEndpoints
{
    public static IEndpointRouteBuilder MapModEndpoints(this IEndpointRouteBuilder app)
    {
        // A missing load order or git refuses the whole selection once; every other refusal is an item of
        // the answer.
        app.MapPost("/build", Build)
            .WithName("BuildMod")
            .WithTags("Mods")
            .Produces<BuildResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        app.MapPost("/init", Init)
            .WithName("InitMod")
            .WithTags("Mods")
            .WithDescription(
                "Puts each mod under git (ADR-0007): a repository in its source folder holding the plugin source of every " +
                "plugin it provides, the files no installation file yields as its assets, and a build configuration naming " +
                "its folder as the output, in one commit. A mod lands or is refused whole. Progress is the init-progress notification.")
            .Produces<InitResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        return app;
    }

    // init-mod: the selection (commands.md, A selection is one gesture); the load order says each mod's plugins and folder.
    internal static async Task<IResult> Init(InitRequest req, InitHandler initHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(ModEndpoints));
        var mods = req.Mods ?? [];
        if (mods.Count == 0)
            return Results.Problem("At least one mod is required.", statusCode: 400);
        if (mods.Any(mod => string.IsNullOrWhiteSpace(mod.Name) || (mod.InstallationFiles ?? []).Any(file => !file.IsWhole)
            || (mod.ModManagerFiles ?? []).Any(string.IsNullOrWhiteSpace)))
        {
            return Results.Problem(
                "Every mod needs a name, and every installation file a path, a size, a hash and its entries, each with a path and a hash.",
                statusCode: 400);
        }

        return await EndpointMapping.Answered(
            "Init", logger,
            initHandler.InitAsync([.. mods.Select(mod => new ModToInit(
                mod.Name, [.. (mod.InstallationFiles ?? []).Select(file => file.ToInstallationFile())], mod.ModManagerFiles ?? []))]),
            EndpointMapping.Refusal,
            landed => new InitializedModResponse(landed.Item, landed.Outcome.Plugins),
            refused => new ModInitRefusal(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new InitResponse(applied, refused));
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

/// <summary>The mods to init (ADR-0024).</summary>
internal sealed record InitRequest(IReadOnlyList<InitModRequest> Mods);

/// <summary>A mod by name, with its installation files in the mod manager's order and the mod manager's own files in
/// its folder, by forward-slash path, which no build makes.</summary>
internal sealed record InitModRequest(
    string Name, IReadOnlyList<InstallationFileRequest> InstallationFiles, IReadOnlyList<string> ModManagerFiles);

/// <summary>A mod of the selection that landed: the plugins whose source its commit holds.</summary>
internal sealed record InitializedModResponse(string Mod, IReadOnlyList<PluginAddress> Plugins);

/// <summary>A mod of the selection that wrote nothing: the typed refusal, and the message naming each refused plugin
/// and why.</summary>
internal sealed record ModInitRefusal(string Item, InitRefusal Refusal, string Message);

/// <summary>Landed or refused, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record InitResponse(IReadOnlyList<InitializedModResponse> Applied, IReadOnlyList<ModInitRefusal> Refused);

/// <summary>A mod of the selection that built: the plugins that compiled, and the plugins refused, which
/// stay as they were.</summary>
internal sealed record BuiltModResponse(
    string Mod, IReadOnlyList<CompiledPlugin> Compiled, IReadOnlyList<PluginCompileRefusal> Refused);

/// <summary>A mod of the selection that wrote nothing: the typed refusal, and the message naming the
/// way out.</summary>
internal sealed record ModBuildRefusal(string Item, BuildRefusal Refusal, string Message);

/// <summary>Applied or refusal, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record BuildResponse(IReadOnlyList<BuiltModResponse> Applied, IReadOnlyList<ModBuildRefusal> Refused);
