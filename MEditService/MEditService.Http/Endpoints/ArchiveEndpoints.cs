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

        app.MapPost("/archives/file", FileBytes)
            .WithName("GetArchiveFile")
            .WithTags("Mods")
            .WithDescription("The bytes of one file in an archive, by the file's forward-slash path there. 404 when the archive does not hold it.")
            .Produces<byte[]>(contentType: "application/octet-stream")
            .ProducesProblem(400)
            .ProducesProblem(404);

        return app;
    }

    internal static IResult FileBytes(ArchiveFileRequest req)
    {
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var release) is { } releaseErr) return releaseErr;
        if (string.IsNullOrWhiteSpace(req.Archive) || string.IsNullOrWhiteSpace(req.File))
            return EndpointMapping.BadRequest("An archive and a file in it are required.");
        try
        {
            return ArchiveReader.FileBytes(release, req.Archive, req.File) is { } bytes
                ? Results.File(bytes, "application/octet-stream")
                : Results.NotFound();
        }
        catch (Exception e) when (e is not (OperationCanceledException or OutOfMemoryException))
        {
            return EndpointMapping.BadRequest(e.Message);
        }
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

/// <summary>One file of an archive: the archive's absolute path, the file's path in it, and the release whose format a BSA is read as.</summary>
internal sealed record ArchiveFileRequest(string GameRelease, string Archive, string File);
