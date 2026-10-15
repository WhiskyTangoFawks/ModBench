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
                "Writes each mod's manifest from the mod as it is (ADR-0022), but a source mod's, which its build writes: that one " +
                "is refused when its folder differs from what the build wrote. A mod lands or is refused on its own, " +
                "and a landed mod names each file nothing provides. Progress is the update-manifest-progress notification, " +
                "which names the request's gesture.")
            .Produces<UpdateManifestResponse>()
            .ProducesProblem(400);

        app.MapPost("/restore-from-manifest", RestoreFromManifest)
            .WithName("RestoreFromManifest")
            .WithTags("Modlist")
            .WithDescription(
                "Writes each file a mod's manifest names whose bytes differ, from the installation files and game files " +
                "it names (ADR-0022), or builds a mod whose manifest names its source at the commit it names, cloning the source " +
                "when it is absent and skipping it at another commit, and names each file no line names, for the extension's " +
                "trash; it writes no other file. A " +
                "mod lands, is skipped naming what it lacks and each installation file and game file the request did not hand, or is " +
                "named not finished when a write failed part way. Progress is the restore-from-manifest-progress notification, " +
                "which names the request's gesture.")
            .Produces<RestoreFromManifestResponse>()
            .ProducesProblem(400);

        app.MapPost("/what-restore-destroys", WhatRestoreDestroys)
            .WithName("WhatRestoreDestroys")
            .WithTags("Modlist")
            .WithDescription(
                "What restore from manifest would destroy in each mod, from its manifest, its files' stamps and the stat cache, " +
                "before anything is written: each file whose bytes the stat cache cannot vouch are its provider's, and each " +
                "file no line names. A mod with no manifest destroys nothing, and a mod whose manifest or a file cannot be read is skipped.")
            .Produces<WhatRestoreDestroysResponse>()
            .ProducesProblem(400);

        app.MapPost("/mod-status", ModStatusOf)
            .WithName("ModStatus")
            .WithTags("Modlist")
            .WithDescription(
                "Each mod's folder against its manifest (modlist-source.md, Status), from its manifest, a stat of each file and " +
                "the stat cache, which keeps what the read found: each file whose bytes differ, each file no line names, each " +
                "file a line names that is gone and each file with no provider, or that it has no manifest or why it cannot be read.")
            .Produces<ModStatusResponse>()
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

    internal static async Task<IResult> UpdateManifest(
        UpdateManifestRequest req, UpdateManifestHandler handler, ModlistGestureCancels cancels, ILoggerFactory loggerFactory, CancellationToken aborted)
    {
        var mods = req.Mods ?? [];
        if (Malformed(mods, req.GameFiles, req.StatCache) is { } malformed) return malformed;

        using var running = cancels.Run(req.Gesture, aborted);
        var result = await handler.UpdateManifestAsync(
            [.. mods.Select(mod => new ModToUpdate(
                mod.Name, mod.Folder, InstallationFilesOf(mod.InstallationFiles), mod.CommittedFiles ?? [], mod.IsSourceMod, mod.Version))],
            new InstanceToUpdate(GameFilesOf(req.GameFiles), req.StatCache), req.Gesture, running.Token);

        var logger = loggerFactory.CreateLogger(nameof(ManifestEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Update manifest", item.Refusal, item.Message, item.Item);
        return Results.Ok(new UpdateManifestResponse(
            [.. result.Landed.Select(landed => new UpdatedModResponse(
                landed.Item, landed.Outcome.ManifestWritten, landed.Outcome.NoProvider, landed.Outcome.StatCacheNotWritten))],
            [.. result.Refused.Select(refused => new ModUpdateManifestRefusal(refused.Item, refused.Refusal, refused.Message))]));
    }

    internal static async Task<IResult> RestoreFromManifest(
        RestoreFromManifestRequest req, RestoreFromManifestHandler handler, ModlistGestureCancels cancels, ILoggerFactory loggerFactory,
        CancellationToken aborted)
    {
        var mods = req.Mods ?? [];
        if (Malformed(mods, req.GameFiles, req.StatCache) is { } malformed) return malformed;
        if (string.IsNullOrWhiteSpace(req.DataFolder)) return Results.Problem("The game's data folder is required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(req.ExcludedSuffix))
            return Results.Problem("The suffix the mod manager gives an excluded file's name is required.", statusCode: 400);
        var variants = req.Archives?.Variants();
        if (req.Archives is not null && variants is null) return Results.Problem(ArchiveVariantsRequest.NotOneEach, statusCode: 400);

        using var running = cancels.Run(req.Gesture, aborted);
        var result = await handler.RestoreAsync(
            [.. mods.Select(mod => new ModToRestore(
                mod.Name, mod.Folder, InstallationFilesOf(mod.InstallationFiles), mod.CommittedFiles ?? [], mod.SourceFolder))],
            new InstanceToRestore(GameFilesOf(req.GameFiles), req.DataFolder, req.StatCache, req.ExcludedSuffix, variants), req.Gesture, running.Token);

        var logger = loggerFactory.CreateLogger(nameof(ManifestEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Restore from manifest", item.Refusal.Kind, item.Message, item.Item);
        return Results.Ok(new RestoreFromManifestResponse(
            [.. result.Landed.Select(landed => new RestoredModResponse(
                landed.Item, landed.Outcome.Written, landed.Outcome.NamedByNoLine, landed.Outcome.StatCacheNotWritten, landed.Outcome.Uncommitted))],
            [.. result.Refused.Select(refused => new ModRestoreRefusal(
                refused.Item, refused.Refusal.Kind, refused.Message, refused.Refusal.GameFilesNotFound, refused.Refusal.InstallationFilesNotFound,
                refused.Refusal.Build))]));
    }

    internal static IResult WhatRestoreDestroys(ModFoldersRequest req, IModFolderRepository repository)
    {
        if (MalformedFolders(req) is { } malformed) return malformed;

        List<ModRestoreDestroys> destroying = [];
        List<ModRestoreRefusal> refused = [];
        foreach (var status in StatusOf(req, repository))
        {
            if (status.Unreadable is { } unreadable)
            {
                refused.Add(new ModRestoreRefusal(
                    status.Mod, unreadable.Manifest ? RestoreRefusal.ManifestUnreadable : RestoreRefusal.Unreadable,
                    $"'{status.Mod}' was skipped: {unreadable.Why}.", [], []));
            }
            else if (status.Differing.Count + status.NamedByNoLine.Count > 0)
                destroying.Add(new ModRestoreDestroys(status.Mod, status.Differing, status.NamedByNoLine));
        }
        return Results.Ok(new WhatRestoreDestroysResponse(destroying, refused));
    }

    internal static IResult ModStatusOf(ModFoldersRequest req, IModFolderRepository repository) =>
        MalformedFolders(req) ?? Results.Ok(new ModStatusResponse(StatusOf(req, repository)));

    private static IResult? MalformedFolders(ModFoldersRequest req)
    {
        if (req.Mods is not { Count: > 0 } || !ModsByFolder.AreWhole(req.Mods))
            return Results.Problem("At least one mod is required, and every mod needs a name, a folder and its committed files.", statusCode: 400);
        return string.IsNullOrWhiteSpace(req.StatCache) ? Results.Problem("The folder of the stat cache is required.", statusCode: 400) : null;
    }

    private static List<ModStatus> StatusOf(ModFoldersRequest req, IModFolderRepository repository) =>
        [.. req.Mods.Select(mod => repository.Status(mod.Folder, mod.Name, mod.CommittedFiles.ToHashSet(StringComparer.Ordinal), req.StatCache))];

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

/// <summary>A mod, whether it is a source mod, whose build writes its manifest, and its version as its metadata says.</summary>
internal sealed record UpdateManifestModRequest(
    string Name, string Folder, IReadOnlyList<InstallationFileRequest> InstallationFiles, IReadOnlyList<string> CommittedFiles, bool IsSourceMod, string? Version)
    : IModRequest;

/// <summary>A game file by its forward-slash path under the game's data folder.</summary>
internal sealed record OverriddenGameFileRequest(string Path, long? Size, string Hash);

/// <summary>A landed mod. StatCacheNotWritten is why the stat cache could not keep what the update read, or null.</summary>
internal sealed record UpdatedModResponse(string Mod, bool ManifestWritten, IReadOnlyList<string> NoProvider, string? StatCacheNotWritten);

internal sealed record ModUpdateManifestRefusal(string Item, UpdateManifestRefusal Refusal, string Message);

/// <summary>Landed or refused, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record UpdateManifestResponse(IReadOnlyList<UpdatedModResponse> Applied, IReadOnlyList<ModUpdateManifestRefusal> Refused);

/// <summary>The mods to restore from their manifests, with the instance's facts (ADR-0013): StatCache as update manifest's,
/// ExcludedSuffix and Archives as build's. Gesture names it to a cancel and in its progress.</summary>
internal sealed record RestoreFromManifestRequest(
    IReadOnlyList<RestoreFromManifestModRequest> Mods, IReadOnlyList<OverriddenGameFileRequest> GameFiles, string DataFolder, string StatCache,
    string ExcludedSuffix, ArchiveVariantsRequest? Archives, string? Gesture);

/// <summary>A mod, with the folder its source is in or is cloned into, none when its name gives it none.</summary>
internal sealed record RestoreFromManifestModRequest(
    string Name, string Folder, IReadOnlyList<InstallationFileRequest> InstallationFiles, IReadOnlyList<string> CommittedFiles, string? SourceFolder)
    : IModRequest;

/// <summary>A mod whose files are as its manifest says: Written each file written to make it so, NamedByNoLine each file
/// no line names, for the trash, StatCacheNotWritten why the stat cache did not keep the read.</summary>
internal sealed record RestoredModResponse(
    string Mod, IReadOnlyList<string> Written, IReadOnlyList<string> NamedByNoLine, string? StatCacheNotWritten, bool Uncommitted);

/// <summary>The mods to read the folders of against their manifests, and the stat cache's folder.</summary>
internal sealed record ModFoldersRequest(IReadOnlyList<ModByFolder> Mods, string StatCache);

internal static class ModsByFolder
{
    /// <summary>Whether a request's mods each name a mod, its folder and its committed files.</summary>
    internal static bool AreWhole(IReadOnlyList<ModByFolder>? mods) =>
        mods is not null
        && mods.All(mod => mod is not null && !string.IsNullOrWhiteSpace(mod.Name) && !string.IsNullOrWhiteSpace(mod.Folder) && mod.CommittedFiles is not null);
}

internal sealed record ModStatusResponse(IReadOnlyList<ModStatus> Mods);

/// <summary>A mod restore would destroy files in, by forward-slash path: each file whose bytes differ from what its
/// provider fixes, and each file no line names.</summary>
internal sealed record ModRestoreDestroys(string Mod, IReadOnlyList<string> Differing, IReadOnlyList<string> NamedByNoLine);

/// <summary>Only the mods restore would destroy a file in, and each mod skipped because a file of it could not be read
/// (ADR-0019).</summary>
internal sealed record WhatRestoreDestroysResponse(IReadOnlyList<ModRestoreDestroys> Mods, IReadOnlyList<ModRestoreRefusal> Refused);

/// <summary>A skipped mod. A NotFound mod names each game file it lacks, by its path under the data folder, and each
/// installation file, by its name; a request that hands them brings it back. A NotBuilt mod names its build's refusal.</summary>
internal sealed record ModRestoreRefusal(
    string Item, RestoreRefusal Refusal, string Message, IReadOnlyList<string> GameFilesNotFound, IReadOnlyList<string> InstallationFilesNotFound,
    BuildRefusal BuildRefusal = BuildRefusal.None);

/// <summary>Landed, skipped or not finished, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record RestoreFromManifestResponse(IReadOnlyList<RestoredModResponse> Applied, IReadOnlyList<ModRestoreRefusal> Refused);
