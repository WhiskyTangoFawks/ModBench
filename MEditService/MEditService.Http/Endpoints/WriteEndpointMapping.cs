using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Http.Endpoints;

/// <summary>The write handlers' shared binding and error-mapping seam, and the one place a refusal is
/// logged.</summary>
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
    /// exactly which (ADR-0019).</summary>
    internal static IResult Refusal(RecordEditResult result) => RecordEditProblem(result.Refusal, result.Message, result.Path);

    internal static IResult Refusal(SelectionRefusal<RecordEditRefusal> refusal) =>
        RecordEditProblem(refusal.Refusal, refusal.Message, path: null);

    /// <summary>Track's own refusal-to-status map, the same posture the record edits' has: the status
    /// says what kind of problem, the refusal extension says exactly which (ADR-0019).</summary>
    internal static IResult Refusal(TrackResult result) => Results.Problem(
        detail: result.Message,
        statusCode: result.Refusal switch
        {
            TrackRefusal.AlreadyTracked => 409,
            // The request is sound; the machine lacks git, or git or the disk refused the write.
            TrackRefusal.GitUnavailable or TrackRefusal.CommitFailed => 500,
            // A data problem in the plugin itself, the status the record edits' own refusals use.
            _ => 422,
        },
        extensions: new Dictionary<string, object?> { ["refusal"] = result.Refusal.ToString() });

    /// <summary>Decompile's refusal of a whole selection: the refusal extension says which cause no
    /// plugin escaped (ADR-0019).</summary>
    internal static IResult Refusal(SelectionRefusal<DecompileRefusal> refusal) => Results.Problem(
        detail: refusal.Message,
        statusCode: refusal.Refusal switch
        {
            // The request is sound; the machine lacks git.
            DecompileRefusal.GitUnavailable => 500,
            _ => 422,
        },
        extensions: new Dictionary<string, object?> { ["refusal"] = refusal.Refusal.ToString() });

    /// <summary>Compile's refusal of a whole selection, mapped as Decompile's is (ADR-0019).</summary>
    internal static IResult Refusal(SelectionRefusal<CompileRefusal> refusal) => Results.Problem(
        detail: refusal.Message,
        statusCode: refusal.Refusal switch
        {
            // The request is sound; the machine lacks git.
            CompileRefusal.GitUnavailable => 500,
            _ => 422,
        },
        extensions: new Dictionary<string, object?> { ["refusal"] = refusal.Refusal.ToString() });

    /// <summary>Create plugin's own refusal, each leaving the folder as it was: the status says what kind
    /// of problem, the refusal extension says exactly which (ADR-0019).</summary>
    internal static IResult Refusal(PluginCreateRefusal refusal, string? message) => Results.Problem(
        detail: message,
        statusCode: refusal switch
        {
            PluginCreateRefusal.FolderGone => 404,
            PluginCreateRefusal.FileExists => 409,
            // The request is sound; the file system refused the write.
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

    /// <summary>A gesture over a selection answers 200 with what landed and what was refused, or the
    /// refusal of the whole selection (ADR-0019).</summary>
    internal static async Task<IResult> Answered<TItem, TRefusal, TOutcome, TLanded, TRefused>(
        string gesture, ILogger logger,
        Task<SelectionResult<TItem, TRefusal, TOutcome>> answer,
        Func<SelectionRefusal<TRefusal>, IResult> refusal,
        Func<ItemLanded<TItem, TOutcome>, TLanded> landed,
        Func<ItemRefused<TItem, TRefusal>, TRefused> refused,
        Func<IReadOnlyList<TLanded>, IReadOnlyList<TRefused>, object> response)
    {
        var result = await answer;
        if (result.SelectionRefusal is { } selectionRefusal)
        {
            LogRefusal(logger, gesture, selectionRefusal.Refusal, selectionRefusal.Message);
            return refusal(selectionRefusal);
        }

        foreach (var item in result.Refused)
            LogRefusal(logger, gesture, item.Refusal, item.Message, item.Item);
        return Results.Ok(response([.. result.Landed.Select(landed)], [.. result.Refused.Select(refused)]));
    }

    internal static void LogRefusal(ILogger logger, string gesture, object? refusal, string? message, object? item = null)
    {
        if (item is null) logger.LogWarning("Refused {Gesture}: {Refusal} — {Message}", gesture, refusal, message);
        else logger.LogWarning("Refused {Gesture} of {Item}: {Refusal} — {Message}", gesture, item, refusal, message);
    }

    private static IResult RecordEditProblem(RecordEditRefusal refusal, string message, string? path) => Results.Problem(
        detail: message,
        statusCode: refusal switch
        {
            // The request is sound; the plugin's present state refuses it until that state changes.
            RecordEditRefusal.PluginNotTracked or RecordEditRefusal.PluginHasNoModFolder
                or RecordEditRefusal.PluginNotActive => 409,
            RecordEditRefusal.RecordNotFound or RecordEditRefusal.FieldNotFound or RecordEditRefusal.PluginNotInLoadOrder => 404,
            // The envelope itself could not be read as a write: the request is malformed.
            RecordEditRefusal.InvalidEnvelope => 400,
            // The request is sound; the machine it runs on lacks git.
            RecordEditRefusal.GitUnavailable => 500,
            // Well-formed, addressed at something real, and still not something we will write.
            _ => 422,
        },
        extensions: new Dictionary<string, object?>
        {
            ["refusal"] = refusal.ToString(),
            ["path"] = path,
        });

    /// <summary>The load order's own failure, which no typed refusal names.</summary>
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

    /// <summary>No Index gate here (ADR-0015): the Index serializes its own projections
    /// afterwards, so a source write never queues behind one and never answers "busy".</summary>
    internal static IResult Execute(
        string gesture, ILogger logger,
        Action? logReceived,
        Func<IResult?> validate,
        Func<RecordEditResult> execute,
        Func<RecordEditResult, IResult> onApplied,
        Func<ArgumentException, IResult>? onMalformedFormKey,
        Func<NoLoadOrderException, IResult> onNoLoadOrder)
    {
        logReceived?.Invoke();

        if (validate() is { } validationFailure)
            return validationFailure;

        try
        {
            var result = execute();
            if (result.Applied) return onApplied(result);

            LogRefusal(logger, gesture, result.Refusal, result.Message);
            return Refusal(result);
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
