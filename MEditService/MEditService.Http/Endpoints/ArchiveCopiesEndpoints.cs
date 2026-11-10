using MEditService.ModFolderAdapter;

namespace MEditService.Http.Endpoints;

internal static class ArchiveCopiesEndpoints
{
    public static IEndpointRouteBuilder MapArchiveCopiesEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/archives/copies", Copies)
            .WithName("GetArchiveCopies")
            .WithTags("Mods")
            .WithDescription(
                "Each of the files an archive holds, by the forward-slash path it was asked for: its size, as the archive's index " +
                "records it, and with hashed, the xxHash64 of its bytes, its eight little-endian bytes in base64. A file the archive " +
                "does not hold is left out. 400 when the archive cannot be read.")
            .Produces<IReadOnlyList<ArchivedCopy>>()
            .ProducesProblem(400);

        return app;
    }

    internal static IResult Copies(ArchiveCopiesRequest req)
    {
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var release) is { } releaseErr) return releaseErr;
        if (string.IsNullOrWhiteSpace(req.Archive) || req.Files is not { Count: > 0 })
            return EndpointMapping.BadRequest("An archive and at least one file in it are required.");
        try
        {
            return Results.Ok(ArchiveReader.Copies(release, req.Archive, req.Files, req.Hashed));
        }
        catch (Exception e) when (e is not (OperationCanceledException or OutOfMemoryException))
        {
            return EndpointMapping.BadRequest(e.Message);
        }
    }
}

/// <summary>The archive to read, by absolute path, the forward-slash paths of the files in it, whether to read their bytes
/// for a hash, and the release whose format a BSA is read as.</summary>
internal sealed record ArchiveCopiesRequest(string GameRelease, string Archive, IReadOnlyList<string> Files, bool Hashed);
