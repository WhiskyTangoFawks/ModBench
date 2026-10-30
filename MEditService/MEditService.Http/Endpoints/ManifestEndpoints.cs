using MEditService.Commands.Build;
using MEditService.ModFolderAdapter;
using MEditService.SourceAdapter;

namespace MEditService.Http.Endpoints;

internal static class ManifestEndpoints
{
    public static IEndpointRouteBuilder MapManifestEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/clone-submodules", CloneSubmodules)
            .WithName("CloneSubmodules")
            .WithTags("Modlist")
            .WithDescription(
                "Clones each source mod's submodule the source folder lacks at the commit the instance repository pins, on its branch " +
                "when that branch is at the pin, so restore from manifest reads the manifest it holds. Each submodule is cloned or " +
                "at its pin, named with why its branch was left elsewhere; at another commit, which it leaves as it is; or named " +
                "with why it was not cloned.")
            .Produces<CloneSubmodulesResult>()
            .ProducesProblem(400);

        return app;
    }

    internal static IResult CloneSubmodules(CloneSubmodulesRequest req, CloneSubmodulesHandler handler, ILoggerFactory loggerFactory, CancellationToken aborted) =>
        req.Submodules is { Count: > 0 } submodules && submodules.All(submodule => submodule is { IsWhole: true })
            ? EndpointMapping.Answered(
                "Clone submodules", loggerFactory.CreateLogger(nameof(ManifestEndpoints)), handler.Clone([.. submodules.Select(submodule => submodule.ToSubmodule())], aborted))
            : EndpointMapping.BadRequest("At least one submodule is required, and every submodule needs the folder git checks it out in and the commit the instance repository pins.");
}

/// <summary>The game folder by the game's name and its root, with the game files a mod's files may be, none
/// when not found. Elsewhere is the Steam install when it is another place (ADR-0013).</summary>
internal sealed record GameFolderRequest(
    string Name, string Root, IReadOnlyList<GameFileRequest> Files, IReadOnlyList<GameFolderPlaceRequest>? Elsewhere = null, IReadOnlyList<GameDepotRequest>? Depots = null)
{
    internal const string NotWhole = "The game folder needs its name, its root, and each game file a path and an xxHash64 hash.";

    internal bool IsWhole =>
        !string.IsNullOrWhiteSpace(Name) && !string.IsNullOrWhiteSpace(Root) && Files is not null
        && GameFileRequest.AreWhole(Files) && GameDepotRequest.AreWhole(Depots) && (Elsewhere ?? []).All(place => place.IsWhole);

    internal GameFolder ToGameFolder() =>
        new(Name, Root, GameFileRequest.ToGameFiles(Files), Elsewhere?.Select(place => place.ToPlace()).ToList(), GameDepotRequest.ToGameDepots(Depots));
}

internal sealed record GameFolderPlaceRequest(string Root, IReadOnlyList<GameFileRequest> Files, IReadOnlyList<GameDepotRequest>? Depots = null)
{
    internal bool IsWhole => !string.IsNullOrWhiteSpace(Root) && Files is not null && GameFileRequest.AreWhole(Files) && GameDepotRequest.AreWhole(Depots);

    internal GameFolderPlace ToPlace() => new(Root, GameFileRequest.ToGameFiles(Files), GameDepotRequest.ToGameDepots(Depots));
}

internal sealed record GameDepotRequest(string Id, string Version)
{
    internal static bool AreWhole(IReadOnlyList<GameDepotRequest>? depots) =>
        (depots ?? []).All(depot => !string.IsNullOrWhiteSpace(depot.Id) && !string.IsNullOrWhiteSpace(depot.Version));

    internal static IReadOnlyList<GameDepot>? ToGameDepots(IReadOnlyList<GameDepotRequest>? depots) => depots?.Select(depot => new GameDepot(depot.Id, depot.Version)).ToList();
}

internal sealed record GameFileRequest(string Path, string Hash, string? PathInFolder = null)
{
    internal static bool AreWhole(IReadOnlyList<GameFileRequest> files) =>
        files.All(file => !string.IsNullOrWhiteSpace(file.Path) && FileHash.IsHash(file.Hash ?? string.Empty));

    internal static IReadOnlyList<GameFile> ToGameFiles(IReadOnlyList<GameFileRequest> files) => [.. files.Select(file => new GameFile(file.Path, file.Hash, file.PathInFolder))];
}

/// <summary>A submodule as the Instance adapter reads the instance repository (ADR-0013): the folder git checks it out in, the
/// commit the instance repository pins, and the branch it follows, if any.</summary>
internal sealed record SubmoduleRequest(string Folder, string Pin, string? Branch)
{
    internal bool IsWhole => !string.IsNullOrWhiteSpace(Folder) && !string.IsNullOrWhiteSpace(Pin);

    internal Submodule ToSubmodule() => new(Folder, Pin, Branch);
}

/// <summary>The submodules to clone, as the Instance adapter reads the instance repository (ADR-0013).</summary>
internal sealed record CloneSubmodulesRequest(IReadOnlyList<SubmoduleRequest> Submodules);
