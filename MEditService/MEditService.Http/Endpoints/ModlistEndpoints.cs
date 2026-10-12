using MEditService.Commands.Engine;

namespace MEditService.Http.Endpoints;

internal static class ModlistEndpoints
{
    public static IEndpointRouteBuilder MapModlistEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/modlist/stage", Stage)
            .WithName("StageModlist")
            .WithTags("Modlist")
            .WithDescription(
                "Writes each mod's manifest from the mod as it is (ADR-0022). A mod lands or is refused on its own, " +
                "and a landed mod names each file nothing provides. Progress is the stage-progress notification.")
            .Produces<StageResponse>()
            .ProducesProblem(400);

        return app;
    }

    internal static IResult Stage(StageRequest req, StageHandler handler, ILoggerFactory loggerFactory, CancellationToken cancel)
    {
        var mods = req.Mods ?? [];
        if (mods.Count == 0) return Results.Problem("At least one mod is required.", statusCode: 400);
        if (mods.Any(mod => string.IsNullOrWhiteSpace(mod.Name) || string.IsNullOrWhiteSpace(mod.Folder)
            || (mod.InstallationFiles ?? []).Any(file => string.IsNullOrWhiteSpace(file.Path))))
        {
            return Results.Problem("Every mod needs a name and a folder, and every installation file a path.", statusCode: 400);
        }
        if (string.IsNullOrWhiteSpace(req.GameFolder)) return Results.Problem("The game folder is required.", statusCode: 400);

        var result = handler.Stage(
            [.. mods.Select(mod => new ModToStage(
                mod.Name, mod.Folder, [.. (mod.InstallationFiles ?? []).Select(file => new InstallationFileToStage(file.Path, file.Source))]))],
            req.GameFolder, cancel);

        var logger = loggerFactory.CreateLogger(nameof(ModlistEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Stage", item.Refusal, item.Message, item.Item);
        return Results.Ok(new StageResponse(
            [.. result.Landed.Select(landed => new StagedModResponse(landed.Item, landed.Outcome.ManifestWritten, landed.Outcome.NoProvider))],
            [.. result.Refused.Select(refused => new ModStageRefusal(refused.Item, refused.Refusal, refused.Message))]));
    }
}

/// <summary>The mods to stage, and the game folder their files may come from.</summary>
internal sealed record StageRequest(IReadOnlyList<StageModRequest> Mods, string GameFolder);

internal sealed record StageModRequest(string Name, string Folder, IReadOnlyList<StageInstallationFileRequest> InstallationFiles);

/// <summary>An installation file by its path, and where the mod manager says it comes from.</summary>
internal sealed record StageInstallationFileRequest(string Path, string? Source);

internal sealed record StagedModResponse(string Mod, bool ManifestWritten, IReadOnlyList<string> NoProvider);

internal sealed record ModStageRefusal(string Item, StageRefusal Refusal, string Message);

/// <summary>Landed or refused, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record StageResponse(IReadOnlyList<StagedModResponse> Applied, IReadOnlyList<ModStageRefusal> Refused);
