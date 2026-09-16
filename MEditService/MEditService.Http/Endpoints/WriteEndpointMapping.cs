using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Http.Endpoints;

/// <summary>The write handlers' shared binding and error-mapping seam. Deliberately does not log:
/// each call site keeps its own structured log line, which a shared mapper cannot generalize
/// without losing the file, FormKey or plugin it names.</summary>
internal static class WriteEndpointMapping
{
    /// <summary>For route-bound (URL-encoded) plugin names only. A body-sourced name must never pass
    /// through here: a literal <c>%</c> would be double-unescaped.</summary>
    internal static PluginKey PluginKeyOf(string routePlugin, string origin) =>
        new(Uri.UnescapeDataString(routePlugin), origin);

    /// <summary>The status code says what kind of problem; the refusal and path extensions say
    /// exactly which, so nobody matches on prose (ADR-0019). eslContradiction marks the one
    /// refusal a header edit can resolve.</summary>
    internal static IResult Refusal(RecordEditResult result) => Results.Problem(
        detail: result.Message,
        statusCode: result.Refusal switch
        {
            // Not-editable-at-all is a state conflict: the request is well-formed, and the answer is
            // "not while this plugin is untracked".
            RecordEditRefusal.PluginNotTracked or RecordEditRefusal.PluginHasNoModFolder => 409,
            RecordEditRefusal.RecordNotFound or RecordEditRefusal.FieldNotFound => 404,
            // The envelope itself could not be read as a write: the request is malformed.
            RecordEditRefusal.InvalidEnvelope => 400,
            // Well-formed, addressed at something real, and still not something we will write.
            _ => 422,
        },
        extensions: new Dictionary<string, object?>
        {
            ["refusal"] = result.Refusal.ToString(),
            ["path"] = result.Path,
            ["eslContradiction"] = result.EslContradiction,
        });

    /// <summary>Track's own refusal-to-status map, the same posture the record edits' has: the status
    /// says what kind of problem, the refusal extension says exactly which (ADR-0019).</summary>
    internal static IResult Refusal(TrackResult result) => Results.Problem(
        detail: result.Message,
        statusCode: result.Refusal switch
        {
            TrackRefusal.NoPluginWithOrigin => 404,
            // Both are state conflicts: the request is well-formed, and the answer is "not on a
            // folder that already has a repository" or "not on the game's own Data folder" — the
            // same status RecordEditRefusal.PluginHasNoModFolder uses for the latter.
            TrackRefusal.AlreadyTracked or TrackRefusal.DataDirectoryOrigin => 409,
            TrackRefusal.GitUnavailable => 500,
            // A data problem in the plugin itself, the status the record edits' own refusals use.
            _ => 422,
        },
        extensions: new Dictionary<string, object?> { ["refusal"] = result.Refusal.ToString() });

    /// <summary>Put load order's own refusal: a bad request, since the only one this handler
    /// answers is discovered by validating the release, never by touching the Index.</summary>
    internal static IResult Refusal(PutLoadOrderResult result) => Results.Problem(
        detail: result.Message,
        statusCode: 400,
        extensions: new Dictionary<string, object?> { ["refusal"] = result.Refusal.ToString() });

    /// <summary>A write to a working tree Modbench does not own exclusively can fail; the caller
    /// builds <paramref name="detail"/> because it is wire body that differs per site, so one shared
    /// message would change what every client reads.</summary>
    internal static IResult WriteFailure(string detail) => Results.Problem(detail, statusCode: 500);

    /// <summary>The load order went away underneath the request — a "not right now", never a bad
    /// request.</summary>
    internal static IResult NoLoadOrder(InvalidOperationException ex) => Results.Problem(ex.Message, statusCode: 503);

    /// <summary>xEdit's typed-FormID path reaches Mutagen's FormKey.Factory with no TryFactory
    /// guard, so a malformed value throws ArgumentException: malformed syntax is a 400, never
    /// <see cref="Refusal(RecordEditResult)"/>'s 422.</summary>
    internal static IResult MalformedFormKey(ArgumentException ex) => Results.Problem(ex.Message, statusCode: 400);

    /// <summary>ADR-0015 invariant 2: no Index gate here. A record gesture writes its system of
    /// record and returns, and the Index serializes its own projections afterwards, so a source
    /// write never queues behind one and never answers "busy".</summary>
    internal static IResult Execute(
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
            var result = execute();
            return result.Applied ? onApplied(result) : Refusal(result);
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
