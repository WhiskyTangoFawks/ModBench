using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Http.Endpoints;

/// <summary>The write handlers' shared binding and error-mapping seam. Deliberately does not log:
/// each call site keeps its own structured log line, which a shared mapper cannot generalize
/// without losing the file, FormKey or plugin it names.</summary>
internal static class WriteEndpointMapping
{
    /// <summary>For route-bound (URL-encoded) plugin names only. A body-sourced name must never pass
    /// through here: a literal <c>%</c> would be double-unescaped.</summary>
    internal static PluginAddress PluginAddressOf(string routePlugin, string origin) =>
        new(Uri.UnescapeDataString(routePlugin), origin);

    /// <summary>The release a request names, or the 400 that says which names are known.</summary>
    internal static IResult? ParseGameRelease(string? raw, out GameRelease release) =>
        Enum.TryParse(raw, out release)
            ? null
            : Results.Problem($"Unknown game release: '{raw}'. Valid values: {string.Join(", ", Enum.GetNames<GameRelease>())}", statusCode: 400);

    /// <summary>The FormKey an applied create or copy allocated. Every caller here reaches
    /// this only once the result is known applied.</summary>
    internal static string RequireNewFormKey(RecordEditResult result) =>
        result.NewFormKey ?? throw new InvalidOperationException("Expected an applied result to carry the new FormKey.");

    /// <summary>The status code says what kind of problem; the refusal and path extensions say
    /// exactly which, so nobody matches on prose (ADR-0019).</summary>
    internal static IResult Refusal(RecordEditResult result) => Results.Problem(
        detail: result.Message,
        statusCode: result.Refusal switch
        {
            // The request is sound; the plugin's present state refuses it until that state changes.
            RecordEditRefusal.PluginNotTracked or RecordEditRefusal.PluginHasNoModFolder
                or RecordEditRefusal.PluginNotActive => 409,
            RecordEditRefusal.RecordNotFound or RecordEditRefusal.FieldNotFound => 404,
            // The envelope itself could not be read as a write: the request is malformed.
            RecordEditRefusal.InvalidEnvelope => 400,
            // The request is sound; the machine it runs on lacks git.
            RecordEditRefusal.GitUnavailable => 500,
            // Well-formed, addressed at something real, and still not something we will write.
            _ => 422,
        },
        extensions: new Dictionary<string, object?>
        {
            ["refusal"] = result.Refusal.ToString(),
            ["path"] = result.Path,
        });

    /// <summary>Track's own refusal-to-status map, the same posture the record edits' has: the status
    /// says what kind of problem, the refusal extension says exactly which (ADR-0019).</summary>
    internal static IResult Refusal(TrackResult result) => Results.Problem(
        detail: result.Message,
        statusCode: result.Refusal switch
        {
            TrackRefusal.PluginNotLoaded => 404,
            // State conflicts: the request is well-formed, and the answer is "not a plugin already
            // tracked" or "not on the game's own Data folder" — the status
            // RecordEditRefusal.PluginHasNoModFolder uses for the second.
            TrackRefusal.AlreadyTracked or TrackRefusal.DataDirectoryOrigin => 409,
            // The request is sound; the machine lacks git, or git or the disk refused the write.
            TrackRefusal.GitUnavailable or TrackRefusal.CommitFailed => 500,
            // A data problem in the plugin itself, the status the record edits' own refusals use.
            _ => 422,
        },
        extensions: new Dictionary<string, object?> { ["refusal"] = result.Refusal.ToString() });

    /// <summary>Decompile's refusal of a whole selection: the refusal extension says which cause no
    /// plugin escaped (ADR-0019).</summary>
    internal static IResult Refusal(DecompileSelectionRefusal refusal) => Results.Problem(
        detail: refusal.Message,
        statusCode: refusal.Refusal switch
        {
            // The request is sound; the machine lacks git.
            DecompileRefusal.GitUnavailable => 500,
            _ => 422,
        },
        extensions: new Dictionary<string, object?> { ["refusal"] = refusal.Refusal.ToString() });

    /// <summary>Create plugin's own refusal, each found before any write: the status says what kind
    /// of problem, the refusal extension says exactly which (ADR-0019).</summary>
    internal static IResult Refusal(PluginCreateRefusal refusal, string? message) => Results.Problem(
        detail: message,
        statusCode: refusal switch
        {
            PluginCreateRefusal.FolderGone => 404,
            PluginCreateRefusal.FileExists => 409,
            // Well-formed, and still not a plugin this game can load.
            _ => 422,
        },
        extensions: new Dictionary<string, object?> { ["refusal"] = refusal.ToString() });

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
    internal static IResult NoLoadOrder(NoLoadOrderException ex) => Results.Problem(ex.Message, statusCode: 503);

    /// <summary>An argument the adapter itself refuses — malformed syntax is a 400. Same shape as
    /// <see cref="MalformedFormKey"/>, kept separate because the argument here is never a FormKey.</summary>
    internal static IResult InvalidArgument(ArgumentException ex) => Results.Problem(ex.Message, statusCode: 400);

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
        Func<NoLoadOrderException, IResult> onNoLoadOrder)
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
        catch (NoLoadOrderException ex)
        {
            return onNoLoadOrder(ex);
        }
    }
}
