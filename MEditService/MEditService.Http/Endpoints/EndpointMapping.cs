using System.ComponentModel;
using System.Diagnostics.CodeAnalysis;
using MEditService.Commands;
using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.Http.Endpoints;

/// <summary>The protocol's one mapping: how a request names a plugin, the one status each refusal of the Index and
/// of the write handlers takes, and the one place a refusal is logged.</summary>
internal static class EndpointMapping
{
    /// <summary>Only a route-bound (URL-encoded) name may pass: a body-sourced one would be double-unescaped on a literal <c>%</c>.</summary>
    internal static bool PluginAt(
        string routePlugin, string? origin, out PluginAddress address, [NotNullWhen(false)] out IResult? refusal)
    {
        if (string.IsNullOrWhiteSpace(origin))
        {
            (address, refusal) = (default, Results.Problem("Origin is required.", statusCode: 400));
            return false;
        }
        (address, refusal) = (new PluginAddress(Uri.UnescapeDataString(routePlugin), origin), null);
        return true;
    }

    /// <summary>A request that is malformed in itself: the protocol's 400, before any handler is reached.</summary>
    internal static IResult BadRequest(string detail) => Results.Problem(detail, statusCode: StatusCodes.Status400BadRequest);

    /// <summary>The release a request names, or the 400 that says which names are known.</summary>
    internal static IResult? ParseGameRelease(string? raw, out GameRelease release) =>
        Enum.TryParse(raw, out release)
            ? null
            : Results.Problem($"Unknown game release: '{raw}'. Valid values: {string.Join(", ", Enum.GetNames<GameRelease>())}", statusCode: 400);

    internal static IResult? ParseStringsLanguage(string raw, out Language language) =>
        Enum.TryParse(raw, out language) && Enum.IsDefined(language)
            ? null
            : Results.Problem($"Unknown strings language: '{raw}'. Valid values: {string.Join(", ", Enum.GetNames<Language>())}", statusCode: 400);

    private static IResult NoLoadOrderProblem() =>
        Results.Problem(
            NoLoadOrderException.DefaultMessage, statusCode: StatusCodes.Status503ServiceUnavailable,
            extensions: new Dictionary<string, object?> { ["refusal"] = nameof(IndexRefusal.NoLoadOrder) });

    private static IResult Problem<TRefusal>(
        TRefusal refusal, TRefusal noLoadOrder, string? message, Func<TRefusal, int> status,
        IReadOnlyDictionary<string, object?>? more = null)
        where TRefusal : struct, Enum
    {
        if (EqualityComparer<TRefusal>.Default.Equals(refusal, noLoadOrder)) return NoLoadOrderProblem();

        var extensions = new Dictionary<string, object?> { ["refusal"] = refusal.ToString() };
        foreach (var (key, value) in more ?? new Dictionary<string, object?>()) extensions[key] = value;
        return Results.Problem(detail: message, statusCode: status(refusal), extensions: extensions);
    }

    // A whole selection is refused for no load order or a machine without git, and for nothing else (ADR-0019).
    private static IResult WholeSelection<TRefusal>(SelectionRefusal<TRefusal> refusal, TRefusal noLoadOrder, TRefusal gitUnavailable)
        where TRefusal : struct, Enum =>
        Problem(
            refusal.Refusal, noLoadOrder, refusal.Message,
            r => EqualityComparer<TRefusal>.Default.Equals(r, gitUnavailable)
                ? 500
                : throw new InvalidEnumArgumentException(nameof(refusal), Convert.ToInt32(r), typeof(TRefusal)));

    /// <summary>The status code says what kind of problem; the refusal and path extensions say
    /// exactly which (ADR-0019).</summary>
    internal static IResult Refusal(RecordEditResult result) => RecordEditProblem(result.Refusal, result.Message, result.Path);

    internal static IResult Refusal(RecordEditRefused refused) => RecordEditProblem(refused.Refusal, refused.Message, refused.Path);

    internal static IResult Refusal(SelectionRefusal<RecordEditRefusal> refusal) =>
        RecordEditProblem(refusal.Refusal, refusal.Message, path: null);

    internal static IResult Refusal(SelectionRefusal<DecompileAndCommitRefusal> refusal) =>
        WholeSelection(refusal, DecompileAndCommitRefusal.NoLoadOrder, DecompileAndCommitRefusal.GitUnavailable);

    internal static IResult Refusal(SelectionRefusal<BuildRefusal> refusal) =>
        WholeSelection(refusal, BuildRefusal.NoLoadOrder, BuildRefusal.GitUnavailable);

    internal static IResult Refusal(SelectionRefusal<DecompileRefusal> refusal) =>
        WholeSelection(refusal, DecompileRefusal.NoLoadOrder, DecompileRefusal.GitUnavailable);

    internal static IResult Refusal(SelectionRefusal<DecompileAndRepairRefusal> refusal) =>
        WholeSelection(refusal, DecompileAndRepairRefusal.NoLoadOrder, DecompileAndRepairRefusal.GitUnavailable);

    internal static IResult Refusal(SelectionRefusal<CompileRefusal> refusal) =>
        WholeSelection(refusal, CompileRefusal.NoLoadOrder, CompileRefusal.GitUnavailable);

    /// <summary>Create plugin's own refusal, each leaving the folder as it was: the status says what kind
    /// of problem, the refusal extension says exactly which (ADR-0019).</summary>
    internal static IResult Refusal(PluginCreateRefusal refusal, string? message) => Problem(
        refusal, PluginCreateRefusal.NoLoadOrder, message,
        r => r switch
        {
            PluginCreateRefusal.FolderGone or PluginCreateRefusal.OriginNotAMod => 404,
            PluginCreateRefusal.FileExists => 409,
            PluginCreateRefusal.NotAPluginFile => 400,
            // Well-formed, and still not a plugin this game can load or a write the file system will take.
            _ => 422,
        });

    /// <summary>Rename source's own refusal, each leaving the plugin's source as it was: the status says
    /// what kind of problem, the refusal extension says exactly which (ADR-0019).</summary>
    internal static IResult Refusal(RenameSourceRefusal refusal, string? message) => Problem(
        refusal, RenameSourceRefusal.NoLoadOrder, message,
        r => r switch
        {
            RenameSourceRefusal.NotAPluginFile or RenameSourceRefusal.TreeNameNotThePlugins => 400,
            RenameSourceRefusal.PluginNotLoaded => 404,
            // The request is sound; the plugin's present state refuses it until that state changes.
            RenameSourceRefusal.NotCompiledPlugin or RenameSourceRefusal.NameTaken => 409,
            // The request is sound; the machine lacks git, or git or the disk refused the write.
            RenameSourceRefusal.GitUnavailable or RenameSourceRefusal.WriteFailed => 500,
            // Well-formed, addressed at something real, and its source holds a file nothing can read.
            _ => 422,
        });

    /// <summary>Put load order's own refusal: a bad request, since none of them is found by touching the Index.</summary>
    internal static IResult Refusal(PutLoadOrderRefused refused) => Results.Problem(
        detail: refused.Message,
        statusCode: 400,
        extensions: new Dictionary<string, object?> { ["refusal"] = refused.Refusal.ToString() });

    /// <summary>The store rebuild's refusal: a held index is 423
    /// Locked (ADR-0010), and a read that never ended is the service's own failure.</summary>
    internal static IResult Refusal(StoreRebuildRefused refused) => Results.Problem(
        detail: refused.Message,
        statusCode: refused.Refusal switch
        {
            StoreRebuildRefusal.HeldByAnotherWindow => 423,
            StoreRebuildRefusal.StillServingReads => 500,
            _ => throw new InvalidEnumArgumentException(nameof(refused), (int)refused.Refusal, typeof(StoreRebuildRefusal)),
        },
        extensions: new Dictionary<string, object?> { ["refusal"] = refused.Refusal.ToString() });

    /// <summary>No load order, an index not yet ready, or one out of memory while other reads hold it, is a "not
    /// right now", never a bad request.</summary>
    internal static IResult Refusal(IndexRefused refused) => new Logged(refused.Refusal.ToString(), refused.Message, Results.Problem(
        refused.Message,
        statusCode: refused.Refusal switch
        {
            IndexRefusal.NoLoadOrder or IndexRefusal.IndexNotReady or IndexRefusal.OutOfMemory => StatusCodes.Status503ServiceUnavailable,
            IndexRefusal.FilterRejected or IndexRefusal.SelectRejected or IndexRefusal.NameRefused => StatusCodes.Status400BadRequest,
            IndexRefusal.SourceStopped => StatusCodes.Status422UnprocessableEntity,
            _ => throw new InvalidEnumArgumentException(nameof(refused), (int)refused.Refusal, typeof(IndexRefusal)),
        },
        extensions: new Dictionary<string, object?> { ["refusal"] = refused.Refusal.ToString() }));

    private sealed class Logged(string refusal, string message, IResult problem) : IResult
    {
        public Task ExecuteAsync(HttpContext httpContext)
        {
            httpContext.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(EndpointMapping))
                .LogWarning(
                    "{Method} {Path} refused: {Refusal} — {Message}",
                    httpContext.Request.Method, httpContext.Request.Path, refusal, message);
            return problem.ExecuteAsync(httpContext);
        }
    }

    internal static IResult Ok<T>(Answer<T, IndexRefused> answer) => Answered(answer, Results.Ok);

    internal static IResult Answered<T>(Answer<T, IndexRefused> answer, Func<T, IResult> onAnswered) =>
        answer.Holds(out var value, out var refused) ? onAnswered(value) : Refusal(refused);

    /// <summary>A gesture over a selection answers 200 with its answer, or the refusal of the whole
    /// selection (ADR-0019).</summary>
    internal static async Task<IResult> Answered<TAnswer, TRefusal>(
        string gesture, ILogger logger,
        Task<Answer<TAnswer, SelectionRefusal<TRefusal>>> answer,
        Func<SelectionRefusal<TRefusal>, IResult> refusal)
        where TAnswer : ISelectionAnswer<IItemRefused<TRefusal>>
    {
        if (!(await answer).Holds(out var answered, out var selectionRefusal))
        {
            LogRefusal(logger, gesture, selectionRefusal.Refusal, selectionRefusal.Message);
            return refusal(selectionRefusal);
        }

        return Answered<TRefusal>(gesture, logger, answered);
    }

    /// <summary>A gesture over a selection that no cause refuses whole answers 200 with its answer.</summary>
    internal static IResult Answered<TRefusal>(
        string gesture, ILogger logger, ISelectionAnswer<IItemRefused<TRefusal>> answered)
    {
        foreach (var item in answered.Refused)
            LogRefusal(logger, gesture, item.Refusal, item.Message, item.Item);
        return Results.Ok(answered);
    }

    /// <summary>A gesture on one record answers 200 with its answer, or the refusal that left the source as it was
    /// (ADR-0019).</summary>
    internal static IResult Answered<T>(string gesture, ILogger logger, Answer<T, RecordEditRefused> answer, Func<T, IResult> onAnswered)
    {
        if (answer.Holds(out var value, out var refused)) return onAnswered(value);

        LogRefusal(logger, gesture, refused.Refusal, refused.Message);
        return Refusal(refused);
    }

    /// <summary>A gesture on one record that answers only that it applied: 204, or the refusal that left the source as it
    /// was (ADR-0019).</summary>
    internal static IResult Answered(string gesture, ILogger logger, RecordEditResult result)
    {
        if (result.Applied) return Results.NoContent();

        LogRefusal(logger, gesture, result.Refusal, result.Message);
        return Refusal(result);
    }

    internal static IResult Answered(string gesture, ILogger logger, Answer<PutLoadOrderApplied, PutLoadOrderRefused> answer)
    {
        if (answer.Holds(out var applied, out var refused)) return Results.Ok(applied);

        LogRefusal(logger, gesture, refused.Refusal, refused.Message);
        return Refusal(refused);
    }

    internal static IResult Answered(string gesture, ILogger logger, PluginAddress plugin, Answer<PluginAddress, PluginCreateRefused> answer)
    {
        if (answer.Holds(out var created, out var refused)) return Results.Ok(created);

        LogRefusal(logger, gesture, refused.Refusal, refused.Message, plugin);
        return Refusal(refused.Refusal, refused.Message);
    }

    internal static IResult Answered(string gesture, ILogger logger, PluginAddress plugin, RenameSourceResult result) =>
        result.Match(
            Results.Ok,
            (refusal, message) =>
            {
                LogRefusal(logger, gesture, refusal, message, plugin);
                return Refusal(refusal, message);
            });

    internal static IResult Answered(string gesture, ILogger logger, PluginAddress plugin, MoveLastWrittenResult result)
    {
        if (result.Refusal is not { } refusal) return Results.NoContent();

        LogRefusal(logger, gesture, refusal, result.Message, plugin);
        return Refusal(refusal, result.Message);
    }

    internal static void LogRefusal<TRefusal>(ILogger logger, string gesture, TRefusal refusal, string? message) =>
        logger.LogWarning("Refused {Gesture}: {Refusal} — {Message}", gesture, refusal, message);

    internal static void LogRefusal<TRefusal, TItem>(ILogger logger, string gesture, TRefusal refusal, string? message, TItem item) =>
        logger.LogWarning("Refused {Gesture} of {Item}: {Refusal} — {Message}", gesture, item, refusal, message);

    private static IResult RecordEditProblem(RecordEditRefusal refusal, string message, string? path) => Problem(
        refusal, RecordEditRefusal.NoLoadOrder, message,
        r => r switch
        {
            // The request is sound; the plugin's present state refuses it until that state changes.
            RecordEditRefusal.PluginNotCompiledPlugin or RecordEditRefusal.PluginHasNoModFolder
                or RecordEditRefusal.PluginSourceUnreadable or RecordEditRefusal.UnsavedChanges => 409,
            RecordEditRefusal.RecordNotFound or RecordEditRefusal.FieldNotFound or RecordEditRefusal.PluginNotInLoadOrder => 404,
            // The envelope itself could not be read as a write: the request is malformed.
            RecordEditRefusal.InvalidEnvelope => 400,
            // The request is sound; the machine it runs on lacks git.
            RecordEditRefusal.GitUnavailable => 500,
            // Well-formed, addressed at something real, and still not something we will write.
            _ => 422,
        },
        new Dictionary<string, object?> { ["path"] = path });
}
