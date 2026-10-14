using MEditService.LoadOrder;

namespace MEditService.Http.Endpoints;

internal static class StringsLanguageEndpoints
{
    public static IEndpointRouteBuilder MapStringsLanguageEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPut("/strings-language", PutStringsLanguage)
            .WithName("PutStringsLanguage")
            .WithTags("Records")
            .WithDescription(
                "The language a translated text shows in, English until one is put. A change reads again the plugins " +
                "whose rows took their texts in another language.")
            .Produces(204)
            .ProducesProblem(400);

        return app;
    }

    internal static IResult PutStringsLanguage(StringsLanguageRequest request, StringsLanguageHolder holder)
    {
        if (EndpointMapping.ParseStringsLanguage(request.Language, out var language) is { } refused) return refused;
        holder.Set(language);
        return Results.NoContent();
    }
}
