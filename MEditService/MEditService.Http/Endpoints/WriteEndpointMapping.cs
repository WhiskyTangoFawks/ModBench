using System.ComponentModel;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Index.Queries;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Http.Endpoints;

/// <summary>The binding shared by the endpoints that take unsaved documents, the write handlers' error-mapping
/// seam, and the one place a refusal is logged.</summary>
internal static class WriteEndpointMapping
{
    /// <summary>For route-bound (URL-encoded) plugin names only. A body-sourced name must never pass
    /// through here: a literal <c>%</c> would be double-unescaped.</summary>
    internal static PluginAddress PluginAddressOf(string routePlugin, string origin) =>
        new(Uri.UnescapeDataString(routePlugin), origin);

    /// <summary>The unsaved texts a hand-over carries, which stand in for their files.</summary>
    internal static IReadOnlyList<SourceAdapter.DocumentChange> Unsaved(IReadOnlyList<DocumentChange> documents) =>
        [.. documents.Select(document => new SourceAdapter.DocumentChange(document.Path, document.Text))];

    /// <summary>The 400 for a request that omits its unsaved texts: without them mEdit would read the disk.</summary>
    internal static IResult? MissingDocuments(IReadOnlyList<DocumentChange>? documents) =>
        documents is null ? Results.Problem("The unsaved documents are required, empty when none are dirty.", statusCode: 400) : null;

    /// <summary>The release a request names, or the 400 that says which names are known.</summary>
    internal static IResult? ParseGameRelease(string? raw, out GameRelease release) =>
        Enum.TryParse(raw, out release)
            ? null
            : Results.Problem($"Unknown game release: '{raw}'. Valid values: {string.Join(", ", Enum.GetNames<GameRelease>())}", statusCode: 400);

    /// <summary>The FormKey an applied create or copy allocated. Every caller here reaches
    /// this only once the result is known applied.</summary>
    internal static string RequireNewFormKey(RecordEditResult result) =>
        result.NewFormKey ?? throw new InvalidOperationException("Expected an applied result to carry the new FormKey.");

    private static IResult Problem<TRefusal>(
        TRefusal refusal, string? message, Func<TRefusal, int> status, IReadOnlyDictionary<string, object?>? more = null)
        where TRefusal : struct, Enum
    {
        if (refusal.ToString() == nameof(RecordEditRefusal.NoLoadOrder))
            return Results.Problem(NoLoadOrderException.DefaultMessage, statusCode: StatusCodes.Status503ServiceUnavailable);

        var extensions = new Dictionary<string, object?> { ["refusal"] = refusal.ToString() };
        foreach (var (key, value) in more ?? new Dictionary<string, object?>()) extensions[key] = value;
        return Results.Problem(detail: message, statusCode: status(refusal), extensions: extensions);
    }

    /// <summary>The status code says what kind of problem; the refusal and path extensions say
    /// exactly which (ADR-0019).</summary>
    internal static IResult Refusal(RecordEditResult result) => RecordEditProblem(result.Refusal, result.Message, result.Path);

    internal static IResult Refusal(SelectionRefusal<RecordEditRefusal> refusal) =>
        RecordEditProblem(refusal.Refusal, refusal.Message, path: null);

    /// <summary>Track's own refusal-to-status map, the same posture the record edits' has: the status
    /// says what kind of problem, the refusal extension says exactly which (ADR-0019).</summary>
    internal static IResult Refusal(SelectionRefusal<TrackRefusal> refusal) => Problem(
        refusal.Refusal, refusal.Message,
        r => r switch
        {
            TrackRefusal.AlreadyTracked => 409,
            // The request is sound; the machine lacks git, or git or the disk refused the write.
            TrackRefusal.GitUnavailable or TrackRefusal.CommitFailed => 500,
            // A data problem in the plugin itself, the status the record edits' own refusals use.
            _ => 422,
        });

    /// <summary>Decompile's refusal of a whole selection: the refusal extension says which cause no
    /// plugin escaped (ADR-0019).</summary>
    internal static IResult Refusal(SelectionRefusal<DecompileRefusal> refusal) => Problem(
        refusal.Refusal, refusal.Message,
        r => r switch
        {
            // The request is sound; the machine lacks git.
            DecompileRefusal.GitUnavailable => 500,
            _ => 422,
        });

    /// <summary>Compile's refusal of a whole selection, mapped as Decompile's is (ADR-0019).</summary>
    internal static IResult Refusal(SelectionRefusal<CompileRefusal> refusal) => Problem(
        refusal.Refusal, refusal.Message,
        r => r switch
        {
            // The request is sound; the machine lacks git.
            CompileRefusal.GitUnavailable => 500,
            _ => 422,
        });

    /// <summary>Create plugin's own refusal, each leaving the folder as it was: the status says what kind
    /// of problem, the refusal extension says exactly which (ADR-0019).</summary>
    internal static IResult Refusal(PluginCreateRefusal refusal, string? message) => Problem(
        refusal, message,
        r => r switch
        {
            PluginCreateRefusal.FolderGone => 404,
            PluginCreateRefusal.FileExists => 409,
            PluginCreateRefusal.NotAPluginFile => 400,
            // The request is sound; the file system refused the write.
            PluginCreateRefusal.WriteFailed => 422,
            // Well-formed, and still not a plugin this game can load.
            _ => 422,
        });

    /// <summary>Rename source's own refusal, each leaving the plugin's source as it was: the status says
    /// what kind of problem, the refusal extension says exactly which (ADR-0019).</summary>
    internal static IResult Refusal(RenameSourceRefusal refusal, string? message) => Problem(
        refusal, message,
        r => r switch
        {
            RenameSourceRefusal.NotAPluginFile or RenameSourceRefusal.TreeNameNotThePlugins => 400,
            RenameSourceRefusal.PluginNotLoaded => 404,
            // The request is sound; the plugin's present state refuses it until that state changes.
            RenameSourceRefusal.NotTracked or RenameSourceRefusal.NameTaken => 409,
            // The request is sound; the machine lacks git, or git or the disk refused the write.
            RenameSourceRefusal.GitUnavailable or RenameSourceRefusal.WriteFailed => 500,
            // Well-formed, addressed at something real, and its source holds a file nothing can read.
            _ => 422,
        });

    /// <summary>Put load order's own refusal: a bad request, since none of them is found by touching the Index.</summary>
    internal static IResult Refusal(PutLoadOrderResult result) => Results.Problem(
        detail: result.Message,
        statusCode: 400,
        extensions: new Dictionary<string, object?> { ["refusal"] = result.Refusal.ToString() });

    /// <summary>The store rebuild's refusal: a missing instance root is a bad request, a held index is 423
    /// Locked (ADR-0010), and a read that never ended is the service's own failure.</summary>
    internal static IResult Refusal(StoreRebuildRefused refused) => Results.Problem(
        detail: refused.Message,
        statusCode: refused.Refusal switch
        {
            StoreRebuildRefusal.InstanceRootNotFound => 400,
            StoreRebuildRefusal.HeldByAnotherWindow => 423,
            StoreRebuildRefusal.StillServingReads => 500,
            _ => throw new InvalidEnumArgumentException(nameof(refused), (int)refused.Refusal, typeof(StoreRebuildRefusal)),
        },
        extensions: new Dictionary<string, object?> { ["refusal"] = refused.Refusal.ToString() });

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

    internal static void LogRefusal<TRefusal>(ILogger logger, string gesture, TRefusal refusal, string? message) =>
        logger.LogWarning("Refused {Gesture}: {Refusal} — {Message}", gesture, refusal, message);

    internal static void LogRefusal<TRefusal, TItem>(ILogger logger, string gesture, TRefusal refusal, string? message, TItem item) =>
        logger.LogWarning("Refused {Gesture} of {Item}: {Refusal} — {Message}", gesture, item, refusal, message);

    private static IResult RecordEditProblem(RecordEditRefusal refusal, string message, string? path) => Problem(
        refusal, message,
        r => r switch
        {
            // The request is sound; the plugin's present state refuses it until that state changes.
            RecordEditRefusal.PluginNotTracked or RecordEditRefusal.PluginHasNoModFolder
                or RecordEditRefusal.PluginSourceUnreadable => 409,
            RecordEditRefusal.RecordNotFound or RecordEditRefusal.FieldNotFound or RecordEditRefusal.PluginNotInLoadOrder => 404,
            // The envelope itself could not be read as a write: the request is malformed.
            RecordEditRefusal.InvalidEnvelope => 400,
            // The request is sound; the machine it runs on lacks git.
            RecordEditRefusal.GitUnavailable => 500,
            // Well-formed, addressed at something real, and still not something we will write.
            _ => 422,
        },
        new Dictionary<string, object?> { ["path"] = path });

    /// <summary>No Index gate here (ADR-0015): the Index serializes its own projections
    /// afterwards, so a source write never queues behind one and never answers "busy".</summary>
    internal static IResult Execute(
        string gesture, ILogger logger,
        Action? logReceived,
        Func<IResult?> validate,
        Func<RecordEditResult> execute,
        Func<RecordEditResult, IResult> onApplied) =>
        Execute(gesture, logger, logReceived, validate, execute, result => result, onApplied);

    /// <summary><see cref="Execute(string, ILogger, Action?, Func{IResult?}, Func{RecordEditResult}, Func{RecordEditResult, IResult})"/>
    /// for an answer that carries more than its <paramref name="outcome"/>.</summary>
    internal static IResult Execute<T>(
        string gesture, ILogger logger,
        Action? logReceived,
        Func<IResult?> validate,
        Func<T> execute,
        Func<T, RecordEditResult> outcome,
        Func<T, IResult> onApplied)
    {
        logReceived?.Invoke();

        if (validate() is { } validationFailure)
            return validationFailure;

        var answer = execute();
        var result = outcome(answer);
        if (result.Applied) return onApplied(answer);

        LogRefusal(logger, gesture, result.Refusal, result.Message);
        return Refusal(result);
    }
}
