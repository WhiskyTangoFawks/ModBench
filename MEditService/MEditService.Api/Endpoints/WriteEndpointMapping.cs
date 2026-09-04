using MEditService.Core.Edits;
using MEditService.Core.Records;

namespace MEditService.Api.Endpoints;

/// <summary>The write handlers' shared binding and error-mapping seam. Deliberately does not log:
/// each call site keeps its own structured log line, which a shared mapper cannot generalize
/// without losing the file, FormKey or plugin it names.</summary>
internal static class WriteEndpointMapping
{
    /// <summary>For route-bound (URL-encoded) plugin names only. A body-sourced name must never pass
    /// through here: a literal <c>%</c> would be double-unescaped.</summary>
    internal static PluginKey PluginKeyOf(string routePlugin, string origin) =>
        new(Uri.UnescapeDataString(routePlugin), origin);

    /// <summary>The status code tells an ordinary HTTP client the kind of problem; the refusal
    /// extension tells an agent exactly which one, so nobody matches on prose (ADR-0026).
    /// eslContradiction marks the one refusal a header edit can resolve.</summary>
    internal static IResult Refusal(RecordEditResult result) => Results.Problem(
        detail: result.Message,
        statusCode: result.Refusal switch
        {
            // Not-editable-at-all is a state conflict: the request is well-formed, and the answer is
            // "not while this plugin is untracked".
            RecordEditRefusal.PluginNotTracked or RecordEditRefusal.PluginHasNoModFolder => 409,
            RecordEditRefusal.RecordNotFound or RecordEditRefusal.FieldNotFound => 404,
            // Well-formed, addressed at something real, and still not something we will write.
            _ => 422,
        },
        extensions: new Dictionary<string, object?>
        {
            ["refusal"] = result.Refusal.ToString(),
            ["eslContradiction"] = result.EslContradiction,
        });

    /// <summary>A write to a working tree Modbench does not own exclusively can fail; the caller
    /// builds <paramref name="detail"/> because it is wire body that differs per site, so one shared
    /// message would change what every client reads.</summary>
    internal static IResult WriteFailure(string detail) => Results.Problem(detail, statusCode: 500);

    /// <summary>The load order went away underneath the request — a "not right now", never a bad
    /// request.</summary>
    internal static IResult NoLoadOrder(InvalidOperationException ex) => Results.Problem(ex.Message, statusCode: 503);

    /// <summary>503, not 500: the write was never attempted, so nothing is half-applied and the right
    /// response is a retry. The writeGateTimeout extension tells it apart from
    /// <see cref="NoLoadOrder"/>, which wants a reload instead (ADR-0026).</summary>
    internal static IResult WriteGateBusy(IndexWriteGateTimeoutException ex) => Results.Problem(
        detail: ex.Message,
        statusCode: 503,
        extensions: new Dictionary<string, object?> { ["writeGateTimeout"] = true });

    /// <summary>xEdit's typed-FormID path reaches Mutagen's FormKey.Factory with no TryFactory
    /// guard, so a malformed value throws ArgumentException: malformed syntax is a 400, never
    /// <see cref="Refusal"/>'s 422.</summary>
    internal static IResult MalformedFormKey(ArgumentException ex) => Results.Problem(ex.Message, statusCode: 400);

    /// <summary>The gate wraps only the service call, so a malformed request never queues and the
    /// response is shaped while the next write runs; taking it here makes one-write-at-a-time a
    /// property of the write path.</summary>
    internal static IResult Execute(
        IndexWriteGate gate,
        Action? logReceived,
        Func<IResult?> validate,
        Func<RecordEditResult> execute,
        Func<RecordEditResult, IResult> onApplied,
        Func<Exception, IResult> onWriteFailure,
        Func<ArgumentException, IResult>? onMalformedFormKey,
        Func<InvalidOperationException, IResult> onNoLoadOrder)
    {
        logReceived?.Invoke();

        if (validate() is { } validationFailure)
            return validationFailure;

        try
        {
            RecordEditResult result;
            using (gate.Enter()) result = execute();
            return result.Applied ? onApplied(result) : Refusal(result);
        }
        catch (IndexWriteGateTimeoutException ex)
        {
            // The gate is what makes this honest answer reachable: without it, a nested
            // BeginTransaction on the shared connection throws InvalidOperationException, which the
            // catch below reports as the load order having gone away.
            return WriteGateBusy(ex);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return onWriteFailure(ex);
        }
        catch (ArgumentException ex) when (onMalformedFormKey is not null)
        {
            return onMalformedFormKey(ex);
        }
        catch (InvalidOperationException ex)
        {
            return onNoLoadOrder(ex);
        }
    }
}
