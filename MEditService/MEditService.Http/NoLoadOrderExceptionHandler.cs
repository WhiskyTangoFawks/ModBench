using MEditService.LoadOrder;
using Microsoft.AspNetCore.Diagnostics;

namespace MEditService.Http;

/// <summary>The one answer to a request that needs a load order the service does not yet hold: a
/// "not right now", never a bad request.</summary>
internal sealed class NoLoadOrderExceptionHandler(ILogger<NoLoadOrderExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not NoLoadOrderException noLoadOrder) return false;

        logger.LogWarning(noLoadOrder, "{Method} {Path} needs a load order", httpContext.Request.Method, httpContext.Request.Path);
        await Results.Problem(noLoadOrder.Message, statusCode: StatusCodes.Status503ServiceUnavailable)
            .ExecuteAsync(httpContext);
        return true;
    }
}
