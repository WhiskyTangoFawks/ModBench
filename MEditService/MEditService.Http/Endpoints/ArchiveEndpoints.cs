using MEditService.ModFolderAdapter;

namespace MEditService.Http.Endpoints;

internal static class ArchiveEndpoints
{
    public static IEndpointRouteBuilder MapArchiveEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/archives/contents", Contents)
            .WithName("GetArchiveContents")
            .WithTags("Mods")
            .WithDescription(
                "What each archive holds, by its absolute path: each file's path in it, with forward slashes, or none and why the " +
                "archive could not be read. The release says which game's archive format a BSA is read as.")
            .Produces<IReadOnlyList<ArchiveContents>>()
            .ProducesProblem(400);

        return app;
    }

    internal static IResult Contents(ArchiveContentsRequest req)
    {
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var release) is { } releaseErr) return releaseErr;
        return req.Archives is { Count: > 0 } archives && archives.All(archive => !string.IsNullOrWhiteSpace(archive))
            ? Results.Ok(archives.Select(archive => ArchiveReader.Contents(release, archive)).ToList())
            : EndpointMapping.BadRequest("At least one archive is required, and every archive needs a path.");
    }
}

/// <summary>The archives to read, by absolute path, and the release whose format a BSA is read as.</summary>
internal sealed record ArchiveContentsRequest(string GameRelease, IReadOnlyList<string> Archives);
