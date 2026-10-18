namespace MEditService.Http;

internal static class SameOriginOnly
{
    /// <summary>Refuses a request whose Origin is not this service's own: a page in a browser sends
    /// one, Swagger UI's is the service's own, and the extension and medit.py send none.</summary>
    public static IApplicationBuilder UseSameOriginOnly(this IApplicationBuilder app) =>
        app.Use(async (ctx, next) =>
        {
            var origin = ctx.Request.Headers.Origin.ToString();
            if (origin.Length > 0 && origin != $"{ctx.Request.Scheme}://{ctx.Request.Host}")
            {
                ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
                return;
            }
            await next();
        });
}
