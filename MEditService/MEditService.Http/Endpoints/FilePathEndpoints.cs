using MEditService.Codec.Schema;

namespace MEditService.Http.Endpoints;

internal static class FilePathEndpoints
{
    public static IEndpointRouteBuilder MapFilePathEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/file-paths/resolve", Resolve)
            .WithName("ResolveFilePath")
            .WithTags("Records")
            .WithDescription(
                "The path in the Data folder that a value names in the member at a field path of a record type, as Mutagen's asset " +
                "type places it, the folder it keeps the files of its kind in included, with forward slashes. Needs no index. 400 when the record type " +
                "or the member is unknown or the member holds no path to a file.")
            .Produces<ResolvedFilePath>()
            .ProducesProblem(400);

        return app;
    }

    internal static IResult Resolve(ResolveFilePathRequest req, SchemaReflector schemas)
    {
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var release) is { } releaseErr) return releaseErr;
        if (!schemas.GetSchemas(release).TryGetValue(req.RecordType, out var schema))
            return EndpointMapping.BadRequest($"{release} has no record type '{req.RecordType}'.");
        return AssetPaths.DataPathAt(schema.RecordColumns, req.FieldPath, req.Value) is { } dataPath
            ? Results.Ok(new ResolvedFilePath(dataPath.Replace('\\', '/')))
            : EndpointMapping.BadRequest($"'{req.FieldPath}' of '{req.RecordType}' holds no path to a file.");
    }
}

/// <summary>The release, the schema's table name of the record type, the member path as the record's fields spell it, and the
/// path the member holds.</summary>
internal sealed record ResolveFilePathRequest(string GameRelease, string RecordType, string FieldPath, string Value);

internal sealed record ResolvedFilePath(string DataPath);
