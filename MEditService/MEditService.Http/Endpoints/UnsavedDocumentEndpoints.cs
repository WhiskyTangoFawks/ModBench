using MEditService.Commands;
using MEditService.SourceAdapter;

namespace MEditService.Http.Endpoints;

internal static class UnsavedDocumentEndpoints
{
    public static IEndpointRouteBuilder MapUnsavedDocumentEndpoints(this IEndpointRouteBuilder app)
    {
        // PUT, because opening a document and changing it are one: the whole text at a version, and sending it twice changes nothing.
        app.MapPut("/unsaved-document", PutUnsavedDocument)
            .WithName("PutUnsavedDocument")
            .WithTags("Records")
            .WithDescription(
                "A plugin-source document VS Code opened or changed, read in place of the file at its absolute path. An open " +
                "replaces what is held; a change of a version older than the one held is ignored. Answers once the record index holds it.")
            .Produces(204)
            .ProducesProblem(400);

        app.MapDelete("/unsaved-document", DeleteUnsavedDocument)
            .WithName("DeleteUnsavedDocument")
            .WithTags("Records")
            .WithDescription(
                "A plugin-source document VS Code closed: its file is read again. Answers once the record index holds it.")
            .Produces(204)
            .ProducesProblem(400);

        return app;
    }

    internal static async Task<IResult> PutUnsavedDocument(
        UnsavedDocumentRequest request, PutUnsavedDocumentHandler handler, ILoggerFactory loggerFactory, CancellationToken cancel) =>
        EndpointMapping.Answered(
            nameof(PutUnsavedDocument), loggerFactory.CreateLogger(nameof(UnsavedDocumentEndpoints)),
            await handler.Put(new DocumentChange(request.Path, request.Text), request.Version, request.Opened, cancel));

    internal static async Task<IResult> DeleteUnsavedDocument(
        string path, DeleteUnsavedDocumentHandler handler, ILoggerFactory loggerFactory, CancellationToken cancel) =>
        EndpointMapping.Answered(
            nameof(DeleteUnsavedDocument), loggerFactory.CreateLogger(nameof(UnsavedDocumentEndpoints)),
            await handler.Delete(path, cancel));
}

/// <summary>Text is the whole text of a document VS Code holds unsaved, at its version. Opened is whether VS Code opened it
/// since mEdit last held none.</summary>
internal sealed record UnsavedDocumentRequest(string Path, string Text, long Version, bool Opened);
