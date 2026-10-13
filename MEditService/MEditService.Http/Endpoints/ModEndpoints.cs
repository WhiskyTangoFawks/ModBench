using MEditService.Commands.Build;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

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

        app.MapPost("/build-configuration", ChangeBuildConfiguration)
            .WithName("ChangeBuildConfiguration")
            .WithTags("Mods")
            .WithDescription(
                "Writes a source mod's build configuration in its working tree, keeping all else it says: the output folder's " +
                "new name, and the paths in the mod folder its build excludes. Modbench writes the mod folder in the same gesture.")
            .Produces(204)
            .ProducesProblem(400)
            .ProducesProblem(422)
            .ProducesProblem(500);

        return app;
    }

    // init-mod: the selection (commands.md, A selection is one gesture); the load order says each mod's plugins and folder.
    internal static async Task<IResult> Init(InitRequest req, InitHandler initHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(ModEndpoints));
        var mods = req.Mods ?? [];
        if (mods.Count == 0)
            return Results.Problem("At least one mod is required.", statusCode: 400);
        if (mods.Any(mod => string.IsNullOrWhiteSpace(mod.Name) || string.IsNullOrWhiteSpace(mod.SourceFolder)
            || (mod.InstallationFiles ?? []).Any(file => !file.IsWhole)
            || (mod.ModManagerFiles ?? []).Any(string.IsNullOrWhiteSpace)))
        {
            return Results.Problem(
                "Every mod needs a name and a source folder, and every installation file a path, a size, a hash and its entries, each with a path and a hash.",
                statusCode: 400);
        }

        return await EndpointMapping.Answered(
            "Init", logger,
            initHandler.InitAsync([.. mods.Select(mod => new ModToInit(
                mod.Name, mod.SourceFolder, [.. (mod.InstallationFiles ?? []).Select(file => file.ToInstallationFile())], mod.ModManagerFiles ?? []))]),
            EndpointMapping.Refusal,
            landed => new InitializedModResponse(landed.Item, landed.Outcome.Plugins),
            refused => new ModInitRefusal(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new InitResponse(applied, refused));
    }

    internal static IResult ChangeBuildConfiguration(
        BuildConfigurationRequest req, BuildConfigurationHandler handler, ILoggerFactory loggerFactory)
    {
        IReadOnlyList<string> exclude = req.Exclude ?? [], include = req.Include ?? [];
        if (string.IsNullOrWhiteSpace(req.SourceFolder) || (req.Output is { } output && !IsFolderName(output))
            || !exclude.Concat(include).All(IsPathInTheMod) || (req.Output is null && exclude.Count + include.Count == 0))
        {
            return Results.Problem(
                "A source folder is required, with an output that is a folder name, or paths in the mod folder to exclude or include.",
                statusCode: 400);
        }

        var result = handler.Change(req.SourceFolder, new BuildConfigurationChange(req.Output, exclude, include));
        if (result.Refusal is not { } refusal) return Results.NoContent();
        EndpointMapping.LogRefusal(loggerFactory.CreateLogger(nameof(ModEndpoints)), "Change build configuration", refusal, result.Message, req.SourceFolder);
        return EndpointMapping.Refusal(refusal, result.Message);
    }

    private static bool IsFolderName(string name) => IsPathInTheMod(name) && !name.Contains('/', StringComparison.Ordinal);

    private static bool IsPathInTheMod(string? path) =>
        path is not null && !path.Contains('\\', StringComparison.Ordinal) && !Path.IsPathRooted(path)
        && path.Split('/').All(segment => !string.IsNullOrWhiteSpace(segment) && segment is not ("." or ".."));

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

/// <summary>A source mod's folder, and what to change in its build configuration: the output folder's new name, and
/// forward-slash paths in the mod folder to exclude or include.</summary>
internal sealed record BuildConfigurationRequest(
    string SourceFolder, string? Output, IReadOnlyList<string>? Exclude, IReadOnlyList<string>? Include);

/// <summary>The mods by name; the load order says each one's plugins.</summary>
internal sealed record BuildRequest(IReadOnlyList<string> Mods);

/// <summary>The mods to init (ADR-0024).</summary>
internal sealed record InitRequest(IReadOnlyList<InitModRequest> Mods);

/// <summary>A mod by name, the folder its repository goes in, its installation files in the mod manager's order, and the
/// mod manager's own files in its folder, by forward-slash path, which no build makes.</summary>
internal sealed record InitModRequest(
    string Name, string SourceFolder, IReadOnlyList<InstallationFileRequest> InstallationFiles, IReadOnlyList<string> ModManagerFiles);

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
