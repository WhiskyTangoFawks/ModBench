using MEditService.Commands.Build;
using MEditService.ModFolderAdapter;

namespace MEditService.Http.Endpoints;

internal static class ManifestEndpoints
{
    public static IEndpointRouteBuilder MapManifestEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/update-manifest", UpdateManifest)
            .WithName("UpdateManifest")
            .WithTags("Modlist")
            .WithDescription(
                "Writes each mod's manifest from the mod as it is (ADR-0022), and into the build folder each delta a changed " +
                "file needs. A mod lands or is refused on its own, " +
                "and a landed mod names each file nothing provides. Progress is the update-manifest-progress notification.")
            .Produces<UpdateManifestResponse>()
            .ProducesProblem(400);

        app.MapPost("/restore-from-manifest", RestoreFromManifest)
            .WithName("RestoreFromManifest")
            .WithTags("Modlist")
            .WithDescription(
                "Writes each file a mod's manifest names whose bytes differ, from the installation files, game files and deltas " +
                "it names (ADR-0022), and touches no other file. A mod lands, is skipped naming what it lacks, or is named " +
                "not finished when a write failed part way. Progress is the restore-from-manifest-progress notification.")
            .Produces<RestoreFromManifestResponse>()
            .ProducesProblem(400);

        return app;
    }

    internal static IResult UpdateManifest(UpdateManifestRequest req, UpdateManifestHandler handler, ILoggerFactory loggerFactory, CancellationToken cancel)
    {
        var mods = req.Mods ?? [];
        if (Malformed(mods, [], req.GameFiles) is { } malformed) return malformed;
        if (string.IsNullOrWhiteSpace(req.DataFolder) || string.IsNullOrWhiteSpace(req.BuildFolder) || req.DeltaShare is not (>= 0 and <= 1))
            return Results.Problem("The game's data folder, the build folder and a delta share from 0 to 1 are required.", statusCode: 400);

        var result = handler.UpdateManifest(
            [.. mods.Select(mod => new ModToUpdate(mod.Name, mod.Folder, InstallationFilesOf(mod.InstallationFiles), mod.CommittedFiles ?? []))],
            new InstanceToUpdate(GameFilesOf(req.GameFiles), req.DataFolder, req.BuildFolder, req.DeltaShare.GetValueOrDefault()),
            cancel);

        var logger = loggerFactory.CreateLogger(nameof(ManifestEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Update manifest", item.Refusal, item.Message, item.Item);
        return Results.Ok(new UpdateManifestResponse(
            [.. result.Landed.Select(landed => new UpdatedModResponse(landed.Item, landed.Outcome.ManifestWritten, landed.Outcome.NoProvider))],
            [.. result.Refused.Select(refused => new ModUpdateManifestRefusal(refused.Item, refused.Refusal, refused.Message))]));
    }

    internal static IResult RestoreFromManifest(RestoreFromManifestRequest req, RestoreFromManifestHandler handler, ILoggerFactory loggerFactory, CancellationToken cancel)
    {
        var mods = req.Mods ?? [];
        if (Malformed(mods, req.DownloadedFiles ?? [], req.GameFiles) is { } malformed) return malformed;
        if (string.IsNullOrWhiteSpace(req.DataFolder) || string.IsNullOrWhiteSpace(req.BuildFolder))
            return Results.Problem("The game's data folder and the build folder are required.", statusCode: 400);

        var result = handler.Restore(
            [.. mods.Select(mod => new ModToRestore(mod.Name, mod.Folder, InstallationFilesOf(mod.InstallationFiles)))],
            new InstanceToRestore(
                GameFilesOf(req.GameFiles), req.DataFolder, req.BuildFolder, req.DownloadsFolder, InstallationFilesOf(req.DownloadedFiles)),
            cancel);

        var logger = loggerFactory.CreateLogger(nameof(ManifestEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Restore from manifest", item.Refusal.Kind, item.Message, item.Item);
        return Results.Ok(new RestoreFromManifestResponse(
            [.. result.Landed.Select(landed => new RestoredModResponse(landed.Item, landed.Outcome.Written))],
            [.. result.Refused.Select(refused => new ModRestoreRefusal(
                refused.Item, refused.Refusal.Kind, refused.Message, refused.Refusal.GameFilesNotFound, refused.Refusal.DeltasNotFound))]));
    }

    private static IResult? Malformed(
        IReadOnlyList<IModRequest> mods,
        IReadOnlyList<InstallationFileRequest> downloadedFiles, IReadOnlyList<OverriddenGameFileRequest>? gameFiles)
    {
        if (mods.Count == 0) return Results.Problem("At least one mod is required.", statusCode: 400);
        var installationFiles = mods.SelectMany(mod => mod.InstallationFiles ?? []).Concat(downloadedFiles).ToList();
        if (mods.Any(mod => string.IsNullOrWhiteSpace(mod.Name) || string.IsNullOrWhiteSpace(mod.Folder)) || installationFiles.Any(file => !file.IsWhole))
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

/// <summary>The mods to update the manifests of, with the instance's facts (ADR-0013). DeltaShare is the share of its file a delta may
/// reach before the file has no provider.</summary>
internal sealed record UpdateManifestRequest(
    IReadOnlyList<UpdateManifestModRequest> Mods, IReadOnlyList<OverriddenGameFileRequest> GameFiles, string DataFolder, string BuildFolder, double? DeltaShare);

internal interface IModRequest
{
    string Name { get; }

    string Folder { get; }

    IReadOnlyList<InstallationFileRequest> InstallationFiles { get; }
}

internal sealed record UpdateManifestModRequest(
    string Name, string Folder, IReadOnlyList<InstallationFileRequest> InstallationFiles, IReadOnlyList<string> CommittedFiles) : IModRequest;

/// <summary>A game file by its forward-slash path under the game's data folder.</summary>
internal sealed record OverriddenGameFileRequest(string Path, long? Size, string Hash);

internal sealed record UpdatedModResponse(string Mod, bool ManifestWritten, IReadOnlyList<string> NoProvider);

internal sealed record ModUpdateManifestRefusal(string Item, UpdateManifestRefusal Refusal, string Message);

/// <summary>Landed or refused, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record UpdateManifestResponse(IReadOnlyList<UpdatedModResponse> Applied, IReadOnlyList<ModUpdateManifestRefusal> Refused);

/// <summary>The mods to restore from their manifests, with the instance's facts (ADR-0013). A delta is found in the build folder, loose in the
/// downloads folder, or among the entries of the installation files and DownloadedFiles.</summary>
internal sealed record RestoreFromManifestRequest(
    IReadOnlyList<RestoreFromManifestModRequest> Mods, IReadOnlyList<OverriddenGameFileRequest> GameFiles, string DataFolder, string BuildFolder,
    string? DownloadsFolder, IReadOnlyList<InstallationFileRequest>? DownloadedFiles);

internal sealed record RestoreFromManifestModRequest(string Name, string Folder, IReadOnlyList<InstallationFileRequest> InstallationFiles) : IModRequest;

/// <summary>A mod whose folder is as its manifest says. Written names each file written to make it so.</summary>
internal sealed record RestoredModResponse(string Mod, IReadOnlyList<string> Written);

/// <summary>A skipped mod. A NotFound mod names each game file, by its path under the data folder, and each delta it
/// lacks; a request that names them brings it back.</summary>
internal sealed record ModRestoreRefusal(
    string Item, RestoreRefusal Refusal, string Message, IReadOnlyList<string> GameFilesNotFound, IReadOnlyList<string> DeltasNotFound);

/// <summary>Landed, skipped or not finished, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record RestoreFromManifestResponse(IReadOnlyList<RestoredModResponse> Applied, IReadOnlyList<ModRestoreRefusal> Refused);
