using MEditService.Index;
using MEditService.LoadOrder;
using Microsoft.AspNetCore.Diagnostics;

namespace MEditService.Http;

/// <summary>The one answer to a request that needs a load order the service does not yet hold, or an
/// index not yet ready: a "not right now", never a bad request.</summary>
internal sealed class NotReadyExceptionHandler(ILogger<NotReadyExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not (NoLoadOrderException or IndexNotReadyException)) return false;

        logger.LogWarning(exception, "{Method} {Path} is not ready to answer", httpContext.Request.Method, httpContext.Request.Path);
        await Results.Problem(exception.Message, statusCode: StatusCodes.Status503ServiceUnavailable)
            .ExecuteAsync(httpContext);
        return true;
    }
}
