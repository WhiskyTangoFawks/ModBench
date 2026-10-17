using MEditService.Commands.Build;
using MEditService.ModFolderAdapter;
using MEditService.SourceAdapter;

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
                "is refused when its folder differs from what the build wrote. A mod with no installation file names the game " +
                "folder as its package when the game files the request hands hold each of its files with their bytes. A mod lands or is refused on its own, " +
                "and a landed mod names each file nothing provides. Progress is the update-manifest-progress notification, " +
                "which names the request's gesture.")
            .Produces<UpdateManifestResponse>()
            .ProducesProblem(400);

        app.MapPost("/restore-from-manifest", RestoreFromManifest)
            .WithName("RestoreFromManifest")
            .WithTags("Modlist")
            .WithDescription(
                "Writes each file a mod's manifest names whose bytes differ, from the installation files and game files " +
                "it names (ADR-0022), or builds a mod whose manifest names its submodule at the commit the instance repository " +
                "pins, which git clones when it is absent, skipping it at another commit, and names each file no line names, for " +
                "the extension's trash; it writes no other file. A " +
                "mod lands, is skipped naming what it lacks and each installation file, game file and submodule the request did not hand, or is " +
                "named not finished when a write failed part way. Progress is the restore-from-manifest-progress notification, " +
                "which names the request's gesture.")
            .Produces<RestoreFromManifestResponse>()
            .ProducesProblem(400);

        app.MapPost("/what-restore-destroys", WhatRestoreDestroys)
            .WithName("WhatRestoreDestroys")
            .WithTags("Modlist")
            .WithDescription(
                "What restore from manifest would destroy in each mod, from its manifest, its files' stamps and the stat cache, " +
                "before anything is written: each file whose bytes the stat cache cannot vouch are its package's, and each " +
                "file no line names. A mod with no manifest destroys nothing, and a mod whose manifest or a file cannot be read is skipped.")
            .Produces<WhatRestoreDestroysResponse>()
            .ProducesProblem(400);

        app.MapPost("/mod-status", ModStatusOf)
            .WithName("ModStatus")
            .WithTags("Modlist")
            .WithDescription(
                "Each mod's folder against its manifest (modlist-repository.md, Status), from its manifest, a stat of each file and " +
                "the stat cache, which keeps what the read found: each file whose bytes differ, each file no line names, each " +
                "file a line names that is gone and each file its package does not hold, whether its package has no host, or that " +
                "it has no manifest or why it cannot be read.")
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
        if (Malformed(mods, req.StatCache, req.GameFolder) is { } malformed) return malformed;

        using var running = cancels.Run(req.Gesture, aborted);
        var result = await handler.UpdateManifestAsync(
            [.. mods.Select(mod => new ModToUpdate(
                mod.Name, mod.Folder, mod.InstallationFile?.ToInstallationFile(), mod.MetadataFiles ?? [], mod.IsSourceMod, mod.Version))],
            new InstanceToUpdate(req.StatCache, req.GameFolder?.ToGameFolder()), req.Gesture, running.Token);

        var logger = loggerFactory.CreateLogger(nameof(ManifestEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Update manifest", item.Refusal, item.Message, item.Item);
        return Results.Ok(new UpdateManifestResponse(
            [.. result.Landed.Select(landed => new UpdatedModResponse(
                landed.Item, landed.Outcome.ManifestWritten, landed.Outcome.NotInPackage, landed.Outcome.StatCacheNotWritten))],
            [.. result.Refused.Select(refused => new ModUpdateManifestRefusal(refused.Item, refused.Refusal, refused.Message))]));
    }

    internal static async Task<IResult> RestoreFromManifest(
        RestoreFromManifestRequest req, RestoreFromManifestHandler handler, ModlistGestureCancels cancels, ILoggerFactory loggerFactory,
        CancellationToken aborted)
    {
        var mods = req.Mods ?? [];
        if (Malformed(mods, req.StatCache, req.GameFolder) is { } malformed) return malformed;
        if (string.IsNullOrWhiteSpace(req.ExcludedSuffix))
            return Results.Problem("The suffix the mod manager gives an excluded file's name is required.", statusCode: 400);
        var variants = req.Archives?.Variants();
        if (req.Archives is not null && variants is null) return Results.Problem(ArchiveVariantsRequest.NotOneEach, statusCode: 400);
        if (mods.Any(mod => mod.Submodule is { IsWhole: false }))
            return Results.Problem("Every submodule needs the folder git checks it out in and the commit the instance repository pins.", statusCode: 400);

        using var running = cancels.Run(req.Gesture, aborted);
        var result = await handler.RestoreAsync(
            [.. mods.Select(mod => new ModToRestore(
                mod.Name, mod.Folder, mod.InstallationFile?.ToInstallationFile(), mod.MetadataFiles ?? [], mod.Submodule?.ToSubmodule()))],
            new InstanceToRestore(req.StatCache, req.ExcludedSuffix, variants, req.GameFolder?.ToGameFolder()), req.Gesture, running.Token);

        var logger = loggerFactory.CreateLogger(nameof(ManifestEndpoints));
        foreach (var item in result.Refused) EndpointMapping.LogRefusal(logger, "Restore from manifest", item.Refusal.Kind, item.Message, item.Item);
        return Results.Ok(new RestoreFromManifestResponse(
            [.. result.Landed.Select(landed => new RestoredModResponse(
                landed.Item, landed.Outcome.Written, landed.Outcome.NamedByNoLine, landed.Outcome.StatCacheNotWritten, landed.Outcome.Metadata, landed.Outcome.Uncommitted,
                landed.Outcome.LeftDetached))],
            [.. result.Refused.Select(refused => new ModRestoreRefusal(
                refused.Item, refused.Refusal.Kind, refused.Message, refused.Refusal.InstallationFileNotFound,
                refused.Refusal.GameFilesNotFound, refused.Refusal.Build, refused.Refusal.SubmoduleNotFound))]));
    }

    internal static IResult WhatRestoreDestroys(ModFoldersRequest req, IModFolderRepository repository)
    {
        if (MalformedFolders(req) is { } malformed) return malformed;

        List<ModRestoreDestroys> destroying = [];
        List<ModRestoreRefusal> refused = [];
        List<ManifestMetadataResponse> manifests = [];
        foreach (var (mod, status) in req.Mods.Zip(StatusOf(req, repository)))
        {
            if (status.Unreadable is { } unreadable)
            {
                refused.Add(new ModRestoreRefusal(
                    status.Mod, unreadable.Manifest ? RestoreRefusal.ManifestUnreadable : RestoreRefusal.Unreadable,
                    $"was skipped: {unreadable.Why}.", null, []));
                continue;
            }
            var overwritesMetadata = status.ManifestMetadata is { } says && mod.Metadata?.IsOverwrittenBy(says) == true;
            if (status.ManifestMetadata is not null) manifests.Add(new ManifestMetadataResponse(status.Mod, status.ManifestMetadata));
            if (status.Differing.Count + status.NamedByNoLine.Count > 0 || overwritesMetadata)
                destroying.Add(new ModRestoreDestroys(status.Mod, status.Differing, status.NamedByNoLine, overwritesMetadata));
        }
        return Results.Ok(new WhatRestoreDestroysResponse(destroying, refused, manifests));
    }

    internal static IResult ModStatusOf(ModFoldersRequest req, IModFolderRepository repository) =>
        MalformedFolders(req) ?? Results.Ok(new ModStatusResponse(StatusOf(req, repository)));

    private static IResult? MalformedFolders(ModFoldersRequest req)
    {
        if (req.Mods is not { Count: > 0 } || !ModsByFolder.AreWhole(req.Mods))
            return Results.Problem("At least one mod is required, and every mod needs a name, a folder and its metadata files, and either its metadata or why it is unreadable.", statusCode: 400);
        return string.IsNullOrWhiteSpace(req.StatCache) ? Results.Problem("The folder of the stat cache is required.", statusCode: 400) : null;
    }

    private static List<ModStatus> StatusOf(ModFoldersRequest req, IModFolderRepository repository) =>
        [.. req.Mods.Select(mod => mod.StatusIn(repository, req.StatCache))];

    private static IResult? Malformed(IReadOnlyList<IModRequest> mods, string? statCache, GameFolderRequest? gameFolder)
    {
        if (mods.Count == 0) return Results.Problem("At least one mod is required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(statCache)) return Results.Problem("The folder of the stat cache is required.", statusCode: 400);
        var installationFiles = mods.Select(mod => mod.InstallationFile).OfType<InstallationFileRequest>().ToList();
        if (mods.Any(mod => string.IsNullOrWhiteSpace(mod.Name) || string.IsNullOrWhiteSpace(mod.Folder)) || installationFiles.Any(file => !file.IsWhole))
        {
            return Results.Problem(
                "Every mod needs a name and a folder, and every installation file a path, a size, a hash and its entries, each with a path and a hash.",
                statusCode: 400);
        }
        if (installationFiles.Any(file => !FileHash.IsHash(file.Hash) || file.Entries.Any(entry => !FileHash.IsHash(entry.Hash))))
            return Results.Problem("Every hash is xxHash64 as Wabbajack writes it: eight bytes in base64.", statusCode: 400);
        return gameFolder is null || gameFolder.IsWhole
            ? null
            : Results.Problem("The game folder needs its name, its Data folder, and each game file a path and an xxHash64 hash.", statusCode: 400);
    }

}

/// <summary>The mods to update the manifests of, with the instance's facts (ADR-0013). StatCache is the stat cache's folder,
/// outside every mod folder. Gesture names it to a cancel and in its progress.</summary>
internal sealed record UpdateManifestRequest(
    IReadOnlyList<UpdateManifestModRequest> Mods, string StatCache, GameFolderRequest? GameFolder, string? Gesture);

/// <summary>The game folder by the game's name and its Data folder, with the game files at the paths of the mods' files, none
/// when the Instance adapter did not find it (ADR-0013).</summary>
internal sealed record GameFolderRequest(string Name, string DataFolder, IReadOnlyList<GameFileRequest> Files)
{
    internal bool IsWhole =>
        !string.IsNullOrWhiteSpace(Name) && !string.IsNullOrWhiteSpace(DataFolder) && Files is not null
        && Files.All(file => !string.IsNullOrWhiteSpace(file.Path) && FileHash.IsHash(file.Hash ?? string.Empty));

    internal GameFolder ToGameFolder() => new(Name, DataFolder, [.. Files.Select(file => new GameFile(file.Path, file.Hash))]);
}

internal sealed record GameFileRequest(string Path, string Hash);

internal interface IModRequest
{
    string Name { get; }

    string Folder { get; }

    InstallationFileRequest? InstallationFile { get; }
}

/// <summary>A mod, whether it is a source mod, whose build writes its manifest, and its version as its metadata says.</summary>
internal sealed record UpdateManifestModRequest(
    string Name, string Folder, InstallationFileRequest? InstallationFile, IReadOnlyList<string> MetadataFiles, bool IsSourceMod, string? Version)
    : IModRequest;

/// <summary>A landed mod. StatCacheNotWritten is why the stat cache could not keep what the update read, or null.</summary>
internal sealed record UpdatedModResponse(string Mod, bool ManifestWritten, IReadOnlyList<string> NotInPackage, string? StatCacheNotWritten);

internal sealed record ModUpdateManifestRefusal(string Item, UpdateManifestRefusal Refusal, string Message);

/// <summary>Landed or refused, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record UpdateManifestResponse(IReadOnlyList<UpdatedModResponse> Applied, IReadOnlyList<ModUpdateManifestRefusal> Refused);

/// <summary>The mods to restore from their manifests, with the instance's facts (ADR-0013): StatCache and GameFolder as update
/// manifest's, ExcludedSuffix and Archives as build's. Gesture names it to a cancel and in its progress.</summary>
internal sealed record RestoreFromManifestRequest(
    IReadOnlyList<RestoreFromManifestModRequest> Mods, string StatCache, string ExcludedSuffix, ArchiveVariantsRequest? Archives,
    GameFolderRequest? GameFolder, string? Gesture);

/// <summary>A mod, with the submodule its manifest names, none until a refusal names it.</summary>
internal sealed record RestoreFromManifestModRequest(
    string Name, string Folder, InstallationFileRequest? InstallationFile, IReadOnlyList<string> MetadataFiles, SubmoduleRequest? Submodule)
    : IModRequest;

/// <summary>A submodule as the Instance adapter reads the instance repository (ADR-0013): the folder git checks it out in, the
/// commit the instance repository pins, and the branch it follows, if any.</summary>
internal sealed record SubmoduleRequest(string Folder, string Pin, string? Branch)
{
    internal bool IsWhole => !string.IsNullOrWhiteSpace(Folder) && !string.IsNullOrWhiteSpace(Pin);

    internal Submodule ToSubmodule() => new(Folder, Pin, Branch);
}

/// <summary>A mod whose files are as its manifest says: Written each file written, NamedByNoLine each file no line names,
/// StatCacheNotWritten why the stat cache did not keep the read, Metadata its manifest's version and page.</summary>
internal sealed record RestoredModResponse(
    string Mod, IReadOnlyList<string> Written, IReadOnlyList<string> NamedByNoLine, string? StatCacheNotWritten, ModMetadata Metadata, bool Uncommitted,
    string? LeftDetached);

/// <summary>The mods to read the folders of against their manifests, and the stat cache's folder.</summary>
internal sealed record ModFoldersRequest(IReadOnlyList<ModByFolder> Mods, string StatCache);

internal static class ModsByFolder
{
    /// <summary>Whether a request's mods each name a mod, its folder and its metadata files.</summary>
    internal static bool AreWhole(IReadOnlyList<ModByFolder>? mods) =>
        mods is not null
        && mods.All(mod => mod is not null && !string.IsNullOrWhiteSpace(mod.Name) && !string.IsNullOrWhiteSpace(mod.Folder) && mod.MetadataFiles is not null
            && (mod.Metadata is null || mod.MetadataUnreadable is null));
}

internal sealed record ModStatusResponse(IReadOnlyList<ModStatus> Mods);

/// <summary>A mod restore would destroy files in, by forward-slash path: each file whose bytes differ from its package's,
/// each file no line names, and whether it replaces a version or page in the metadata.</summary>
internal sealed record ModRestoreDestroys(string Mod, IReadOnlyList<string> Differing, IReadOnlyList<string> NamedByNoLine, bool MetadataDiffers);

/// <summary>Only the mods restore would destroy a file or metadata in, each mod skipped because a file of it could not be
/// read (ADR-0019), and the metadata each manifest says.</summary>
internal sealed record WhatRestoreDestroysResponse(
    IReadOnlyList<ModRestoreDestroys> Mods, IReadOnlyList<ModRestoreRefusal> Refused, IReadOnlyList<ManifestMetadataResponse> Manifests);

internal sealed record ManifestMetadataResponse(string Mod, ModMetadata Metadata);

/// <summary>A skipped mod. A NotFound mod names the installation file, the game files and the submodule it lacks, for a request
/// to hand. A NotBuilt mod names its build's refusal.</summary>
internal sealed record ModRestoreRefusal(
    string Item, RestoreRefusal Refusal, string Message, string? InstallationFileNotFound, IReadOnlyList<string> GameFilesNotFound,
    BuildRefusal BuildRefusal = BuildRefusal.None, string? SubmoduleNotFound = null);

/// <summary>Landed, skipped or not finished, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record RestoreFromManifestResponse(IReadOnlyList<RestoredModResponse> Applied, IReadOnlyList<ModRestoreRefusal> Refused);
