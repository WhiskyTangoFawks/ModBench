using MEditService.Commands.Build;

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
            || (mod.InstallationFiles ?? []).Any(file => string.IsNullOrWhiteSpace(file.Path) || file.Size is null
                || string.IsNullOrWhiteSpace(file.Hash) || file.Entries is null || file.Entries.Any(entry => string.IsNullOrWhiteSpace(entry.Path) || string.IsNullOrWhiteSpace(entry.Hash)))))
        {
            return Results.Problem(
                "Every mod needs a name and a folder, and every installation file a path, a size, a hash and its entries, each with a path and a hash.",
                statusCode: 400);
        }
        if (req.GameFiles is not { } gameFiles || gameFiles.Any(file => string.IsNullOrWhiteSpace(file.Path) || file.Size is null || string.IsNullOrWhiteSpace(file.Hash)))
            return Results.Problem("The game files the mods override are required, each with a path, a size and a hash.", statusCode: 400);

        var result = handler.Stage(
            [.. mods.Select(mod => new ModToStage(
                mod.Name, mod.Folder,
                [.. (mod.InstallationFiles ?? []).Select(file => new InstallationFileToStage(
                    file.Path, file.Source, file.Size.GetValueOrDefault(), file.Hash, [.. file.Entries.Select(entry => new HashedEntry(entry.Path, entry.Hash))]))],
                mod.CommittedFiles ?? []))],
            [.. gameFiles.Select(file => new GameFileToStage(file.Path, file.Size.GetValueOrDefault(), file.Hash))],
            cancel);

        var logger = loggerFactory.CreateLogger(nameof(ModlistEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Stage", item.Refusal, item.Message, item.Item);
        return Results.Ok(new StageResponse(
            [.. result.Landed.Select(landed => new StagedModResponse(landed.Item, landed.Outcome.ManifestWritten, landed.Outcome.NoProvider))],
            [.. result.Refused.Select(refused => new ModStageRefusal(refused.Item, refused.Refusal, refused.Message))]));
    }
}

/// <summary>The mods to stage, and each game file a mod file overrides (ADR-0024).</summary>
internal sealed record StageRequest(IReadOnlyList<StageModRequest> Mods, IReadOnlyList<StageGameFileRequest> GameFiles);

internal sealed record StageModRequest(
    string Name, string Folder, IReadOnlyList<StageInstallationFileRequest> InstallationFiles, IReadOnlyList<string> CommittedFiles);

/// <summary>An installation file by its path, where the mod manager says it comes from, and its size, hash and
/// entries as the Instance adapter knows them (ADR-0024).</summary>
internal sealed record StageInstallationFileRequest(
    string Path, string? Source, long? Size, string Hash, IReadOnlyList<StageInstallationFileEntryRequest> Entries);

/// <summary>An entry of an installation file by its forward-slash path inside it.</summary>
internal sealed record StageInstallationFileEntryRequest(string Path, string Hash);

/// <summary>A game file by its forward-slash path under the game's data folder.</summary>
internal sealed record StageGameFileRequest(string Path, long? Size, string Hash);

internal sealed record StagedModResponse(string Mod, bool ManifestWritten, IReadOnlyList<string> NoProvider);

internal sealed record ModStageRefusal(string Item, StageRefusal Refusal, string Message);

/// <summary>Landed or refused, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record StageResponse(IReadOnlyList<StagedModResponse> Applied, IReadOnlyList<ModStageRefusal> Refused);
