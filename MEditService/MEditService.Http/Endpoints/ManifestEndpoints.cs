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
                "Writes each mod's manifest from the mod as it is (ADR-0022). A mod lands or is refused on its own, " +
                "and a landed mod names each file nothing provides. Progress is the update-manifest-progress notification, " +
                "which names the request's gesture.")
            .Produces<UpdateManifestResponse>()
            .ProducesProblem(400);

        app.MapPost("/restore-from-manifest", RestoreFromManifest)
            .WithName("RestoreFromManifest")
            .WithTags("Modlist")
            .WithDescription(
                "Writes each file a mod's manifest names whose bytes differ, from the installation files and game files " +
                "it names (ADR-0022), and touches no other file. A mod lands, is skipped naming what it lacks, or is named " +
                "not finished when a write failed part way. Progress is the restore-from-manifest-progress notification, " +
                "which names the request's gesture.")
            .Produces<RestoreFromManifestResponse>()
            .ProducesProblem(400);

        app.MapPost("/modlist-gestures/{gesture}/cancel", (string gesture, ModlistGestureCancels cancels) =>
                cancels.Cancel(gesture)
                    ? Results.NoContent()
                    : Results.Problem($"No modlist gesture '{gesture}' is running.", statusCode: 404))
            .WithName("CancelModlistGesture")
            .WithTags("Modlist")
            .WithDescription(
                "Stops the running modlist gesture its client named after the mod in hand. Its request then answers the mods " +
                "it finished.")
            .Produces(204)
            .ProducesProblem(404);

        return app;
    }

    internal static IResult UpdateManifest(
        UpdateManifestRequest req, UpdateManifestHandler handler, ModlistGestureCancels cancels, ILoggerFactory loggerFactory, CancellationToken aborted)
    {
        var mods = req.Mods ?? [];
        if (Malformed(mods, req.GameFiles, req.StatCache) is { } malformed) return malformed;

        using var running = cancels.Run(req.Gesture, aborted);
        var result = handler.UpdateManifest(
            [.. mods.Select(mod => new ModToUpdate(mod.Name, mod.Folder, InstallationFilesOf(mod.InstallationFiles), mod.CommittedFiles ?? []))],
            new InstanceToUpdate(GameFilesOf(req.GameFiles), req.StatCache), req.Gesture, running.Token);

        var logger = loggerFactory.CreateLogger(nameof(ManifestEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Update manifest", item.Refusal, item.Message, item.Item);
        return Results.Ok(new UpdateManifestResponse(
            [.. result.Landed.Select(landed => new UpdatedModResponse(
                landed.Item, landed.Outcome.ManifestWritten, landed.Outcome.NoProvider, landed.Outcome.StatCacheNotWritten))],
            [.. result.Refused.Select(refused => new ModUpdateManifestRefusal(refused.Item, refused.Refusal, refused.Message))]));
    }

    internal static IResult RestoreFromManifest(
        RestoreFromManifestRequest req, RestoreFromManifestHandler handler, ModlistGestureCancels cancels, ILoggerFactory loggerFactory,
        CancellationToken aborted)
    {
        var mods = req.Mods ?? [];
        if (Malformed(mods, req.GameFiles, req.StatCache) is { } malformed) return malformed;
        if (string.IsNullOrWhiteSpace(req.DataFolder)) return Results.Problem("The game's data folder is required.", statusCode: 400);

        using var running = cancels.Run(req.Gesture, aborted);
        var result = handler.Restore(
            [.. mods.Select(mod => new ModToRestore(mod.Name, mod.Folder, InstallationFilesOf(mod.InstallationFiles)))],
            new InstanceToRestore(GameFilesOf(req.GameFiles), req.DataFolder, req.StatCache), req.Gesture, running.Token);

        var logger = loggerFactory.CreateLogger(nameof(ManifestEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Restore from manifest", item.Refusal.Kind, item.Message, item.Item);
        return Results.Ok(new RestoreFromManifestResponse(
            [.. result.Landed.Select(landed => new RestoredModResponse(landed.Item, landed.Outcome.Written, landed.Outcome.StatCacheNotWritten))],
            [.. result.Refused.Select(refused => new ModRestoreRefusal(refused.Item, refused.Refusal.Kind, refused.Message, refused.Refusal.GameFilesNotFound))]));
    }

    private static IResult? Malformed(IReadOnlyList<IModRequest> mods, IReadOnlyList<OverriddenGameFileRequest>? gameFiles, string? statCache)
    {
        if (mods.Count == 0) return Results.Problem("At least one mod is required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(statCache)) return Results.Problem("The folder of the stat cache is required.", statusCode: 400);
        var installationFiles = mods.SelectMany(mod => mod.InstallationFiles ?? []).ToList();
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

/// <summary>The mods to update the manifests of, with the instance's facts (ADR-0013). StatCache is the stat cache's folder,
/// outside every mod folder. Gesture names it to a cancel and in its progress.</summary>
internal sealed record UpdateManifestRequest(
    IReadOnlyList<UpdateManifestModRequest> Mods, IReadOnlyList<OverriddenGameFileRequest> GameFiles, string StatCache, string? Gesture);

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

/// <summary>A landed mod. StatCacheNotWritten is why the stat cache could not keep what the update read, or null.</summary>
internal sealed record UpdatedModResponse(string Mod, bool ManifestWritten, IReadOnlyList<string> NoProvider, string? StatCacheNotWritten);

internal sealed record ModUpdateManifestRefusal(string Item, UpdateManifestRefusal Refusal, string Message);

/// <summary>Landed or refused, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record UpdateManifestResponse(IReadOnlyList<UpdatedModResponse> Applied, IReadOnlyList<ModUpdateManifestRefusal> Refused);

/// <summary>The mods to restore from their manifests, with the instance's facts (ADR-0013), StatCache as update manifest's.
/// Gesture names it to a cancel and in its progress.</summary>
internal sealed record RestoreFromManifestRequest(
    IReadOnlyList<RestoreFromManifestModRequest> Mods, IReadOnlyList<OverriddenGameFileRequest> GameFiles, string DataFolder, string StatCache,
    string? Gesture);

internal sealed record RestoreFromManifestModRequest(string Name, string Folder, IReadOnlyList<InstallationFileRequest> InstallationFiles) : IModRequest;

/// <summary>A mod whose folder is as its manifest says. Written names each file written to make it so, and
/// StatCacheNotWritten why the stat cache could not keep what the restore read, or null.</summary>
internal sealed record RestoredModResponse(string Mod, IReadOnlyList<string> Written, string? StatCacheNotWritten);

/// <summary>A skipped mod. A NotFound mod names each game file it lacks, by its path under the data folder; a request that
/// names them brings it back.</summary>
internal sealed record ModRestoreRefusal(string Item, RestoreRefusal Refusal, string Message, IReadOnlyList<string> GameFilesNotFound);

/// <summary>Landed, skipped or not finished, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record RestoreFromManifestResponse(IReadOnlyList<RestoredModResponse> Applied, IReadOnlyList<ModRestoreRefusal> Refused);
