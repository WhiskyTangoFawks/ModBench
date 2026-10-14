using MEditService.Commands.Build;
using MEditService.ModFolderAdapter;

namespace MEditService.Http.Endpoints;

internal static class ModlistEndpoints
{
    public static IEndpointRouteBuilder MapModlistEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/modlist/stage", Stage)
            .WithName("StageModlist")
            .WithTags("Modlist")
            .WithDescription(
                "Writes each mod's manifest from the mod as it is (ADR-0022), and into the build folder each delta a changed " +
                "file needs. A mod lands or is refused on its own, " +
                "and a landed mod names each file nothing provides. Progress is the stage-progress notification.")
            .Produces<StageResponse>()
            .ProducesProblem(400);

        app.MapPost("/modlist/discard-changes", DiscardChanges)
            .WithName("DiscardChanges")
            .WithTags("Modlist")
            .WithDescription(
                "Writes each file a mod's manifest names whose bytes differ, from the installation files, game files and deltas " +
                "it names (ADR-0022), and touches no other file. A mod lands, is skipped naming what it lacks, or is named " +
                "not finished when a write failed part way. Progress is the discard-progress notification.")
            .Produces<DiscardResponse>()
            .ProducesProblem(400);

        return app;
    }

    internal static IResult Stage(StageRequest req, StageHandler handler, ILoggerFactory loggerFactory, CancellationToken cancel)
    {
        var mods = req.Mods ?? [];
        if (Malformed(mods.Select(mod => (mod.Name, mod.Folder, mod.InstallationFiles)), [], req.GameFiles) is { } malformed) return malformed;
        if (string.IsNullOrWhiteSpace(req.DataFolder) || string.IsNullOrWhiteSpace(req.BuildFolder) || req.DeltaShare is not (>= 0 and <= 1))
            return Results.Problem("The game's data folder, the build folder and a delta share from 0 to 1 are required.", statusCode: 400);

        var result = handler.Stage(
            [.. mods.Select(mod => new ModToStage(mod.Name, mod.Folder, InstallationFilesOf(mod.InstallationFiles), mod.CommittedFiles ?? []))],
            new InstanceToStage(GameFilesOf(req.GameFiles), req.DataFolder, req.BuildFolder, req.DeltaShare.GetValueOrDefault()),
            cancel);

        var logger = loggerFactory.CreateLogger(nameof(ModlistEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Stage", item.Refusal, item.Message, item.Item);
        return Results.Ok(new StageResponse(
            [.. result.Landed.Select(landed => new StagedModResponse(landed.Item, landed.Outcome.ManifestWritten, landed.Outcome.NoProvider))],
            [.. result.Refused.Select(refused => new ModStageRefusal(refused.Item, refused.Refusal, refused.Message))]));
    }

    internal static IResult DiscardChanges(DiscardRequest req, DiscardHandler handler, ILoggerFactory loggerFactory, CancellationToken cancel)
    {
        var mods = req.Mods ?? [];
        if (Malformed(mods.Select(mod => (mod.Name, mod.Folder, mod.InstallationFiles)), req.DownloadedFiles ?? [], req.GameFiles) is { } malformed)
            return malformed;
        if (string.IsNullOrWhiteSpace(req.DataFolder) || string.IsNullOrWhiteSpace(req.BuildFolder))
            return Results.Problem("The game's data folder and the build folder are required.", statusCode: 400);

        var result = handler.Discard(
            [.. mods.Select(mod => new ModToDiscard(mod.Name, mod.Folder, InstallationFilesOf(mod.InstallationFiles)))],
            new InstanceToDiscard(
                GameFilesOf(req.GameFiles), req.DataFolder, req.BuildFolder, req.DownloadsFolder, InstallationFilesOf(req.DownloadedFiles)),
            cancel);

        var logger = loggerFactory.CreateLogger(nameof(ModlistEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Discard changes", item.Refusal, item.Message, item.Item);
        return Results.Ok(new DiscardResponse(
            [.. result.Landed.Select(landed => new DiscardedModResponse(landed.Item, landed.Outcome.Written))],
            [.. result.Refused.Select(refused => new ModDiscardRefusal(refused.Item, refused.Refusal, refused.Message))]));
    }

    private static IResult? Malformed(
        IEnumerable<(string Name, string Folder, IReadOnlyList<InstallationFileRequest> InstallationFiles)> mods,
        IReadOnlyList<InstallationFileRequest> downloadedFiles, IReadOnlyList<OverriddenGameFileRequest>? gameFiles)
    {
        var listed = mods.ToList();
        if (listed.Count == 0) return Results.Problem("At least one mod is required.", statusCode: 400);
        var installationFiles = listed.SelectMany(mod => mod.InstallationFiles ?? []).Concat(downloadedFiles).ToList();
        if (listed.Any(mod => string.IsNullOrWhiteSpace(mod.Name) || string.IsNullOrWhiteSpace(mod.Folder)) || installationFiles.Any(file => !file.IsWhole))
        {
            return Results.Problem(
                "Every mod needs a name and a folder, and every installation file a path, a size, a hash and its entries, each with a path and a hash.",
                statusCode: 400);
        }
        if (gameFiles is null || gameFiles.Any(file => string.IsNullOrWhiteSpace(file.Path) || file.Size is null || string.IsNullOrWhiteSpace(file.Hash)))
            return Results.Problem("The game files the mods override are required, each with a path, a size and a hash.", statusCode: 400);
        if (installationFiles.Any(file => !FileHash.IsHash(file.Hash) || file.Entries.Any(entry => !FileHash.IsHash(entry.Hash)))
            || gameFiles.Any(file => !FileHash.IsHash(file.Hash)))
            return Results.Problem("Every hash is xxHash64 as Wabbajack writes it: eight bytes in base64.", statusCode: 400);
        return null;
    }

    private static InstallationFile[] InstallationFilesOf(IReadOnlyList<InstallationFileRequest>? files) =>
        [.. (files ?? []).Select(file => file.ToInstallationFile())];

    private static OverriddenGameFile[] GameFilesOf(IReadOnlyList<OverriddenGameFileRequest> files) =>
        [.. files.Select(file => new OverriddenGameFile(file.Path, file.Size.GetValueOrDefault(), file.Hash))];
}

/// <summary>The mods to stage with the instance's facts (ADR-0013). DeltaShare is the share of its file a delta may
/// reach before the file has no provider.</summary>
internal sealed record StageRequest(
    IReadOnlyList<StageModRequest> Mods, IReadOnlyList<OverriddenGameFileRequest> GameFiles, string DataFolder, string BuildFolder, double? DeltaShare);

internal sealed record StageModRequest(
    string Name, string Folder, IReadOnlyList<InstallationFileRequest> InstallationFiles, IReadOnlyList<string> CommittedFiles);

/// <summary>A game file by its forward-slash path under the game's data folder.</summary>
internal sealed record OverriddenGameFileRequest(string Path, long? Size, string Hash);

internal sealed record StagedModResponse(string Mod, bool ManifestWritten, IReadOnlyList<string> NoProvider);

internal sealed record ModStageRefusal(string Item, StageRefusal Refusal, string Message);

/// <summary>Landed or refused, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record StageResponse(IReadOnlyList<StagedModResponse> Applied, IReadOnlyList<ModStageRefusal> Refused);

/// <summary>The mods to discard with the instance's facts (ADR-0013). A delta is found in the build folder, loose in the
/// downloads folder, or among the entries of the installation files and DownloadedFiles.</summary>
internal sealed record DiscardRequest(
    IReadOnlyList<DiscardModRequest> Mods, IReadOnlyList<OverriddenGameFileRequest> GameFiles, string DataFolder, string BuildFolder,
    string? DownloadsFolder, IReadOnlyList<InstallationFileRequest>? DownloadedFiles);

internal sealed record DiscardModRequest(string Name, string Folder, IReadOnlyList<InstallationFileRequest> InstallationFiles);

/// <summary>A mod whose folder is as its manifest says. Written names each file written to make it so.</summary>
internal sealed record DiscardedModResponse(string Mod, IReadOnlyList<string> Written);

internal sealed record ModDiscardRefusal(string Item, DiscardRefusal Refusal, string Message);

/// <summary>Landed, skipped or not finished, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record DiscardResponse(IReadOnlyList<DiscardedModResponse> Applied, IReadOnlyList<ModDiscardRefusal> Refused);
