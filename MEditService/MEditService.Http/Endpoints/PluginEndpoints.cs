using MEditService.Commands;
using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.SourceAdapter;

namespace MEditService.Http.Endpoints;

public static class PluginEndpoints
{
    private const string Tag = "Plugins";

    public static IEndpointRouteBuilder MapPluginEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/plugins", (IRecordQueryService svc) =>
            Results.Ok(svc.GetPlugins().Select(PluginResponse.Of).ToList()))
            .WithName("GetPlugins")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginResponse>>();

        // Every mutable plugin in the load order, diagnosed off its original bytes — the
        // session-load complement of Track's refusal. With no load order applied the refusal is a
        // 503, never an unmapped 500.
        app.MapGet("/plugins/diagnoses", (MalformedPluginQueryService svc, ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
            try
            {
                return Results.Ok(svc.GetLoadOrderDiagnoses());
            }
            catch (NoLoadOrderException ex)
            {
                logger.LogError(ex, "No loadOrder for GetPluginDiagnoses");
                return Results.Problem(ex.Message, statusCode: 503);
            }
        })
            .WithName("GetPluginDiagnoses")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginDiagnosisReport>>()
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/record-types", (string plugin, string? origin, IRecordQueryService svc) =>
        {
            var decoded = Uri.UnescapeDataString(plugin);
            return Results.Ok(svc.GetPluginRecordTypes(decoded, origin));
        })
            .WithName("GetPluginRecordTypes")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginRecordTypeCount>>();

        app.MapPost("/plugins/create", CreatePlugin)
            .WithName("CreatePlugin")
            .WithTags(Tag)
            .WithDescription(
                "Writes an empty plugin (a header whose flags its extension sets, no records and no " +
                "masters) into the given folder, in the release of the held load order. Changes " +
                "nothing else: no Track, no load order change and no plugins.txt line.")
            .Produces<PluginCreatedResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(500)
            .ProducesProblem(503);

        app.MapPost("/plugins/track", Track)
            .WithName("Track")
            .WithTags(Tag)
            .Produces<TrackResponse>()
            .ProducesProblem(400)
            // git missing refuses the whole selection; every other refusal is an item of the answer.
            .ProducesProblem(500)
            .ProducesProblem(503);

        // A missing load order refuses the whole selection once; every other refusal is an item of
        // the answer.
        app.MapPost("/plugins/compile", Compile)
            .WithName("CompilePlugin")
            .WithTags(Tag)
            .Produces<CompileResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        // Create-record — the plugin hosts the new group, so it owns the route the way Compile
        // does; the FormKey doesn't exist yet, which is exactly why this isn't under /records/{formKey}.
        app.MapPost("/plugins/{plugin}/records", CreateRecord)
            .WithName("CreateRecord")
            .WithSummary("Create a new record as a working-tree change.")
            .WithDescription(
                "Mints a new record and writes it as a new source file in the plugin's working tree — " +
                "a git-native create, answering at Effective only until committed and compiled.")
            .WithTags(Tag)
            .Produces<RecordCreateResponse>()
            .ProducesProblem(400)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(500)
            .ProducesProblem(503);

        // Absorb, origin-scoped: the mod is the unit of a baseline, not one plugin in it.
        app.MapPost("/plugins/external-change/absorb", AbsorbExternalChange)
            .WithName("AbsorbExternalChange")
            .WithTags(Tag)
            .Produces<TrackResponse>()
            .ProducesProblem(400)
            // A plugin that cannot be read or parsed refuses the whole answer before anything is
            // written; every other refusal but git missing (500) is an item of the answer.
            .ProducesProblem(422)
            .ProducesProblem(500)
            .ProducesProblem(503);

        // Keep, origin-scoped. A collision (a record or an already-staged tracked file)
        // is ExternalChangeActionResponse.Succeeded == false naming it — never an HTTP error.
        app.MapPost("/plugins/external-change/keep", KeepExternalChange)
            .WithName("KeepExternalChange")
            .WithTags(Tag)
            .Produces<ExternalChangeActionResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        return app;
    }

    internal static async Task<IResult> CreatePlugin(
        CreatePluginRequest req, CreatePluginHandler create, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (Malformed(req) is { } malformed) return malformed;

        try
        {
            var plugin = new PluginAddress(req.Name, req.Origin);
            var result = await create.CreatePlugin(plugin, req.Folder);
            if (result.Refusal is { } refusal)
            {
                logger.LogWarning("Refused to create {Name} in {Origin}: {Refusal}", req.Name, req.Origin, refusal);
                return WriteEndpointMapping.Refusal(refusal, result.Message);
            }

            return Results.Ok(new PluginCreatedResponse(plugin.Name, plugin.Origin, Path.Combine(req.Folder, plugin.Name)));
        }
        catch (NoLoadOrderException ex)
        {
            logger.LogError(ex, "No loadOrder when creating plugin {Name}", req.Name);
            return WriteEndpointMapping.NoLoadOrder(ex);
        }
        catch (ArgumentException ex)
        {
            // Mutagen refuses the filename the request passed the extension check with.
            logger.LogError(ex, "Invalid argument creating plugin {Name}", req.Name);
            return WriteEndpointMapping.InvalidArgument(ex);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not write plugin {Name} into {Folder}", req.Name, req.Folder);
            return WriteEndpointMapping.WriteFailure($"Could not write {req.Name} into {req.Folder}: {ex.Message}");
        }
    }

    // The refusals a malformed request earns, taken before the door so a name that could never be
    // a plugin file writes nothing.
    private static IResult? Malformed(CreatePluginRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.Problem("Plugin name is required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(req.Folder) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("The folder and the origin are required.", statusCode: 400);

        var extension = Path.GetExtension(req.Name);
        return extension.Equals(".esp", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".esm", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".esl", StringComparison.OrdinalIgnoreCase)
            ? null
            : Results.Problem(
                $"Invalid plugin extension '{extension}'. Must be .esp, .esm, or .esl.", statusCode: 400);
    }

    // ADR-0007: the Track gesture over a selection of plugins, each named by file name and origin
    // (ADR-0012); the load order resolves which physical folder each lives in.
    internal static async Task<IResult> Track(
        TrackRequest req, TrackHandler trackHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var plugins = req.Plugins ?? [];
        if (plugins.Count == 0)
            return Results.Problem("At least one plugin is required.", statusCode: 400);
        if (plugins.Any(p => string.IsNullOrWhiteSpace(p.Name) || string.IsNullOrWhiteSpace(p.Origin)))
            return Results.Problem("Every plugin needs a name and an origin.", statusCode: 400);
        if (!Enum.TryParse<SourcePreset>(req.Preset, ignoreCase: true, out var preset))
            return Results.Problem($"Unknown source preset '{req.Preset}'.", statusCode: 400);

        try
        {
            var result = await trackHandler.TrackAsync(plugins, preset);
            if (result.SelectionRefusal is { } selectionRefusal)
            {
                logger.LogWarning("Refused to track {Count} plugin(s): {Refusal} — {Message}",
                    plugins.Count, selectionRefusal.Refusal, selectionRefusal.Message);
                return WriteEndpointMapping.Refusal(selectionRefusal);
            }

            foreach (var refused in result.Refused)
            {
                logger.LogWarning("Refused to track {Plugin} ({Origin}): {Refusal} — {Message}",
                    refused.Plugin.Name, refused.Plugin.Origin, refused.Refusal, refused.Message);
            }
            return Results.Ok(new TrackResponse(
                result.Landed,
                [.. result.Refused.Select(r => new PluginAddressRefusal(r.Plugin, r.Refusal, r.Message))]));
        }
        catch (NoLoadOrderException ex)
        {
            logger.LogError(ex, "No loadOrder when tracking {Count} plugin(s)", plugins.Count);
            return WriteEndpointMapping.NoLoadOrder(ex);
        }
    }

    // compile-plugin: the selection, each plugin named by file name and origin (ADR-0012).
    internal static async Task<IResult> Compile(CompileRequest req, CompilePluginHandler compileHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var plugins = req.Plugins ?? [];
        if (plugins.Count == 0)
            return Results.Problem("At least one plugin is required.", statusCode: 400);
        if (plugins.Any(p => string.IsNullOrWhiteSpace(p.Name) || string.IsNullOrWhiteSpace(p.Origin)))
            return Results.Problem("Every plugin needs a name and an origin.", statusCode: 400);

        try
        {
            var result = await compileHandler.CompileAsync(plugins);
            foreach (var refused in result.Refused)
            {
                logger.LogWarning("Refused to compile {Plugin} ({Origin}): {Message}",
                    refused.Plugin.Name, refused.Plugin.Origin, refused.Message);
            }
            return Results.Ok(new CompileResponse(result.Landed, result.Refused));
        }
        catch (NoLoadOrderException ex)
        {
            logger.LogError(ex, "No loadOrder when compiling {Count} plugin(s)", plugins.Count);
            return WriteEndpointMapping.NoLoadOrder(ex);
        }
    }

    // FormKey null means auto-allocate; non-null is xEdit's typed-FormID path, validated
    // server-side either way. logReceived is null on purpose: no PluginEndpoints handler logs on
    // entry, UseSerilogRequestLogging's per-request summary covers it.
    internal static IResult CreateRecord(
        string plugin, RecordCreateRequest req, CreateRecordHandler edits, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        return WriteEndpointMapping.Execute(
            logReceived: null,
            validate: () =>
            {
                if (string.IsNullOrWhiteSpace(req.Origin))
                    return Results.Problem("Origin is required.", statusCode: 400);
                if (string.IsNullOrWhiteSpace(req.RecordType))
                    return Results.Problem("A record type is required.", statusCode: 400);
                return null;
            },
            execute: () => edits.CreateRecord(WriteEndpointMapping.PluginAddressOf(plugin, req.Origin), req.RecordType, req.EditorId, req.FormKey),
            onApplied: result => Results.Ok(new RecordCreateResponse(true, WriteEndpointMapping.RequireNewFormKey(result), req.RecordType)),
            onWriteFailure: ex =>
            {
                logger.LogError(ex, "Could not write the source file while creating a {RecordType} in {Plugin}", req.RecordType, decoded);
                return WriteEndpointMapping.WriteFailure($"Could not write the source file for the new record: {ex.Message}");
            },
            // req.FormKey reaches Mutagen's FormKey.Factory with no TryFactory guard, so a malformed
            // value throws ArgumentException: malformed syntax is a 400, never Refusal's 422.
            onMalformedFormKey: ex =>
            {
                logger.LogError(ex, "Malformed FormKey creating a {RecordType} in {Plugin}", req.RecordType, decoded);
                return WriteEndpointMapping.MalformedFormKey(ex);
            },
            onNoLoadOrder: ex =>
            {
                logger.LogError(ex, "No usable loadOrder while creating a record in {Plugin}", decoded);
                return WriteEndpointMapping.NoLoadOrder(ex);
            });
    }

    // Absorb, origin-scoped: the question it answers covers the whole mod.
    internal static async Task<IResult> AbsorbExternalChange(
        ExternalChangeActionRequest req, AbsorbExternalChangeHandler handler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        try
        {
            if (await handler.AbsorbAsync(req.Origin) is not { } result)
                return NotATrackedMod(req.Origin, logger);
            if (result.AnswerRefusal is { } answerRefusal)
                return WriteEndpointMapping.Refusal(answerRefusal);
            return Results.Ok(new TrackResponse(
                result.Landed,
                [.. result.Refused.Select(r => new PluginAddressRefusal(r.Plugin, r.Refusal, r.Message))],
                result.TrackedFilesRefusal));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not absorb upstream update for {Origin}", req.Origin);
            return WriteEndpointMapping.WriteFailure($"Could not absorb upstream update for {req.Origin}: {ex.Message}");
        }
    }

    // Keep, origin-scoped. A collision (a record or an already-staged tracked file) is a
    // typed refusal, not an exception — it travels through as a 200, same posture as Compile's own.
    internal static IResult KeepExternalChange(
        ExternalChangeActionRequest req, KeepExternalChangeHandler handler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        try
        {
            if (handler.Keep(req.Origin) is not { } result)
                return NotATrackedMod(req.Origin, logger);
            return Results.Ok(new ExternalChangeActionResponse(result.Applied, result.RefusalReason));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not keep external change for {Origin}", req.Origin);
            return WriteEndpointMapping.WriteFailure($"Could not keep external change for {req.Origin}: {ex.Message}");
        }
    }

    // Untracked or unknown: the handler's one null answer, the caller's single refusal path for both.
    private static IResult NotATrackedMod(string origin, ILogger logger)
    {
        logger.LogWarning("No tracked mod in the load order has origin {Origin}", origin);
        return WriteEndpointMapping.NotTrackedMod(origin);
    }
}

/// <summary>The origin and the file name are the plugin (ADR-0012 invariant 1); the folder is where
/// the instance holds that origin's files.</summary>
public record CreatePluginRequest(string Origin, string Name, string Folder);

/// <summary>The plugin the create gesture wrote and where. Not a plugin row: the Index has not seen
/// it, and nothing registers it.</summary>
public record PluginCreatedResponse(string Name, string Origin, string Path);

/// <summary>A plugin of the selection that wrote nothing of its own: the typed refusal, and the
/// message naming the way out.</summary>
public record PluginAddressRefusal(PluginAddress Plugin, TrackRefusal Refusal, string Message);

// Preset is the wire-safe string form of SourcePreset ("Edits"/"Everything"); a repository that
// already stands keeps its own .gitignore.
public record TrackRequest(IReadOnlyList<PluginAddress> Plugins, string Preset);

/// <summary>Applied or refusal, per plugin (ADR-0019 invariant 4), never the status of the call.
/// Only Absorb sets <see cref="TrackedFilesRefusal"/>: its tracked-files commit is no plugin's,
/// and can fail after every plugin landed.</summary>
public record TrackResponse(
    IReadOnlyList<PluginAddress> Applied, IReadOnlyList<PluginAddressRefusal> Refused, string? TrackedFilesRefusal = null);

public record CompileRequest(IReadOnlyList<PluginAddress> Plugins);

/// <summary>Applied or refusal, per plugin (ADR-0019 invariant 4), never the status of the call.</summary>
public record CompileResponse(IReadOnlyList<CompiledPlugin> Applied, IReadOnlyList<CompileRefused> Refused);

// Absorb / Keep are origin-scoped — the mod, not one plugin in it, is
// the unit of a baseline.
public record ExternalChangeActionRequest(string Origin);

public record ExternalChangeActionResponse(bool Succeeded, string? RefusalReason);
