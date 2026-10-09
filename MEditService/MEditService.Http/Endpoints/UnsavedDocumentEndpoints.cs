namespace MEditService.Http.Endpoints;

internal static class UnsavedDocumentEndpoints
{
    public static IEndpointRouteBuilder MapUnsavedDocumentEndpoints(this IEndpointRouteBuilder app)
    {
        // PUT, because the body is the whole set, and sending it twice changes nothing.
        app.MapPut("/unsaved-documents", PutUnsavedDocuments)
            .WithName("PutUnsavedDocuments")
            .WithTags("SourceLanguage")
            .WithDescription(
                "Every plugin-source document VS Code holds unsaved, each read in place of the file at its absolute " +
                "path, replacing those put before (ADR-0015). Answers once they are held; the plugins whose source " +
                "holds a document put or dropped are validated after, and announce rows-changed.")
            .Produces(204)
            .ProducesProblem(400);

        return app;
    }

    internal static IResult PutUnsavedDocuments(UnsavedDocumentsRequest request, SourceAdapter.UnsavedDocuments unsaved)
    {
        if (WriteEndpointMapping.MissingDocuments(request.Documents) is { } missing) return missing;
        unsaved.Apply(WriteEndpointMapping.Unsaved(request.Documents));
        return Results.NoContent();
    }
}
