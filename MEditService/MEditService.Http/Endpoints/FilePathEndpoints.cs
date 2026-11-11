using System.Text.Json;
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
                "The path in the Data folder that the member at a field path of a record names, as Mutagen's asset type places it, " +
                "the folder it keeps the files of its kind in included, with forward slashes. The record is the text the caller " +
                "holds, and the answer needs no index. 400 when the record type is unknown, the text is no JSON, the member holds " +
                "no path to a file, or its asset type cannot hold the path.")
            .Produces<ResolvedFilePath>()
            .ProducesProblem(400);

        return app;
    }

    internal static IResult Resolve(ResolveFilePathRequest req, SchemaReflector schemas)
    {
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var release) is { } releaseErr) return releaseErr;
        if (!schemas.GetSchemas(release).TryGetValue(req.RecordType, out var schema))
            return EndpointMapping.BadRequest($"{release} has no record type '{req.RecordType}'.");
        NamedFiles named;
        try
        {
            named = AssetPaths.Collect(req.Text, schema.RecordColumns);
        }
        catch (JsonException e)
        {
            return EndpointMapping.BadRequest($"The record text is no JSON: {e.Message}");
        }
        if (named.Files.FirstOrDefault(file => file.FieldPath == req.FieldPath) is { DataPath: { } dataPath })
            return Results.Ok(new ResolvedFilePath(dataPath.Replace('\\', '/')));
        return EndpointMapping.BadRequest(named.Refusals.FirstOrDefault(refusal => refusal.FieldPath == req.FieldPath) is { Reason: { } reason }
            ? reason
            : $"'{req.FieldPath}' of '{req.RecordType}' holds no path to a file.");
    }
}

/// <summary>The release, the schema's table name of the record type, the record's JSON text, and the member path in it as the
/// record's fields spell it.</summary>
internal sealed record ResolveFilePathRequest(string GameRelease, string RecordType, string Text, string FieldPath);

internal sealed record ResolvedFilePath(string DataPath);
