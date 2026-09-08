using MEditService.Bridge;
using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Source;

namespace MEditService.Api.Endpoints;

public static class PluginEndpoints
{
    private const string Tag = "Plugins";

    public static IEndpointRouteBuilder MapPluginEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/plugins", (IRecordQueryService svc) => Results.Ok(svc.GetPlugins()))
            .WithName("GetPlugins")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginResponse>>();

        // Every held, mutable plugin's Kind B diagnoses off its original bytes — the session-load
        // complement of Track's refusal. RequireScope's throw becomes a 503, never an unmapped 500.
        app.MapGet("/plugins/diagnoses", (MalformedPluginQueryService svc, ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
            try
            {
                return Results.Ok(svc.GetLoadOrderDiagnoses());
            }
            catch (InvalidOperationException ex)
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
                "Creates a new plugin at the given path/origin (ADR-0041), Tracking that " +
                "destination under the Edits preset first if it is not already tracked. Does NOT " +
                "add the plugin to any load order — the caller (the extension's Mod Management " +
                "writer, or a script/agent consumer per ADR-0024) is responsible for that.")
            .Produces<PluginResponse>()
            .ProducesProblem(400)
            .ProducesProblem(409)
            .ProducesProblem(500)
            .ProducesProblem(503);

        app.MapPost("/plugins/track", Track)
            .WithName("Track")
            .WithTags(Tag)
            .Produces<TrackResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(500)
            .ProducesProblem(503);

        // Polled alongside the in-flight POST /plugins/track: always 200, no load order
        // dependency, since progress lives on the singleton TrackService.
        app.MapGet("/plugins/track/status", (TrackService trackService) => Results.Ok(trackService.Progress))
            .WithName("GetTrackStatus")
            .WithTags(Tag)
            .Produces<TrackProgress>();

        // No "confirmed" flag: the compile-at-main modal is extension-side UX that must not leak
        // through the wire. Refusal is a typed 200 (CompileResult.Succeeded == false), never an
        // HTTP error.
        app.MapPost("/plugins/{plugin}/compile", Compile)
            .WithName("CompilePlugin")
            .WithTags(Tag)
            .Produces<CompileResult>()
            .ProducesProblem(400)
            .ProducesProblem(500);

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

        // A read-only peek at what CreateRecord/RenumberRecord would allocate, feeding the Renumber
        // gesture's FormID box a default. Refusals go through the same Refusal mapping its siblings
        // use rather than a nullable-string contract that cannot distinguish them.
        app.MapGet("/plugins/{plugin}/records/next-form-key", (
            string plugin, string origin, PeekNextFreeFormKeyHandler edits) =>
        {
            var result = edits.PeekNextFreeFormKey(WriteEndpointMapping.PluginKeyOf(plugin, origin));
            return result.Applied ? Results.Ok(new NextFreeFormKeyResponse(result.NewFormKey!)) : WriteEndpointMapping.Refusal(result);
        })
            .WithName("PeekNextFreeFormKey")
            .WithTags(Tag)
            .Produces<NextFreeFormKeyResponse>()
            .ProducesProblem(404)
            .ProducesProblem(422);

        // Always 200, an empty list when nothing is unanswered; no load order dependency, since
        // the queue lives on the singleton ExternalChangeWatcher.
        app.MapGet("/plugins/external-changes/status", ExternalChangeStatus)
            .WithName("GetExternalChangeStatus")
            .WithTags(Tag)
            .Produces<IReadOnlyList<UnansweredExternalChangeResponse>>();

        // Absorb Upstream Update. 200 either way — a refusal here is the same typed-result
        // posture Compile already established, not an HTTP error a client has to distinguish from a
        // transport failure.
        app.MapPost("/plugins/{plugin}/external-change/absorb", AbsorbExternalChange)
            .WithName("AbsorbExternalChange")
            .WithTags(Tag)
            .Produces<ExternalChangeActionResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        // Keep as My Edit. Same-record collision is ExternalChangeActionResponse.Succeeded ==
        // false with RefusalReason naming the records — never an HTTP error.
        app.MapPost("/plugins/{plugin}/external-change/keep", KeepExternalChange)
            .WithName("KeepExternalChange")
            .WithTags(Tag)
            .Produces<ExternalChangeActionResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        // The offered rebase, and its re-runnable form (Modbench: Rebase onto Updated
        // Baseline). Origin-scoped, not plugin-scoped — the repo is the unit of baselines and
        // rebase, and a mod folder can hold more than one plugin.
        app.MapPost("/plugins/rebase", Rebase)
            .WithName("RebaseEditBranch")
            .WithTags(Tag)
            .Produces<RebaseResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(503);

        app.MapPost("/plugins/rebase/continue", ContinueRebase)
            .WithName("ContinueRebaseEditBranch")
            .WithTags(Tag)
            .Produces<RebaseResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(503);

        return app;
    }

    // ADR-0041: an untracked destination is Tracked in the same gesture, silently and always under
    // Edits — the one-keystroke "Enter accepts overwrite/" framing rules out a second prompt.
    // Never touches plugins.txt; that append is the caller's.
    internal static async Task<IResult> CreatePlugin(
        CreatePluginRequest req, IndexProjector index, LoadOrderHolder holder, TrackService trackService, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.Problem("Plugin name is required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(req.Path) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Destination path and origin are required.", statusCode: 400);

        try
        {
            var plugin = index.CreatePlugin(req.Name, req.Path, req.Origin);
            // ADR-0041: a participant at once, so the gesture below and every later reader see it
            // without waiting for the snapshot that appends its plugins.txt line.
            holder.Register(new RegisteredCopy(
                plugin.Name, plugin.Origin, plugin.Path, plugin.LoadOrderIndex, Enabled: true, Winning: true));

            if (!SourceRepository.IsTracked(req.Path))
            {
                var track = await trackService.TrackAsync(holder.Current, HeldCopies(index), req.Origin, SourcePreset.Edits);
                if (!track.Applied)
                {
                    // Loud, not silent: the plugin file and load order entry already landed, but
                    // plugins.txt is never appended without a 2xx, so no load order can name this
                    // half-created plugin. The orphaned entry is accepted residue.
                    logger.LogError("Refused to track {Origin} while creating {Name}: {Refusal}", req.Origin, req.Name, track.Refusal);
                    // Not WriteEndpointMapping.Refusal's map, which answers 404 and 422 this route
                    // does not declare; widening the declared set is the create route's own work
                    // (debt #797).
                    return Results.Problem(track.Message, statusCode: track.Refusal == TrackRefusal.AlreadyTracked ? 409 : 500);
                }
            }

            return Results.Ok(plugin);
        }
        catch (ArgumentException ex)
        {
            logger.LogError(ex, "Invalid argument creating plugin {Name}", req.Name);
            return Results.Problem(ex.Message, statusCode: 400);
        }
        catch (System.IO.IOException ex)
        {
            logger.LogError(ex, "IO error creating plugin {Name}", req.Name);
            return Results.Problem(ex.Message, statusCode: 409);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No loadOrder when creating plugin {Name}", req.Name);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    // Which registered copies Editing actually holds. A copy the Index could not open is
    // registered like any other but has no bytes to read.
    private static IReadOnlyCollection<PluginKey> HeldCopies(IndexProjector index) =>
        [.. (index.LoadOrder?.Plugins ?? []).Select(p => p.Key)];

    // ADR-0041: the Track gesture. Origin names the mod folder (every loaded plugin sharing
    // it gets tracked together — a mod can hold more than one plugin); the load order resolves
    // which physical folder that is.
    internal static async Task<IResult> Track(
        TrackRequest req, IndexProjector index, LoadOrderHolder holder, TrackHandler trackHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);
        if (!Enum.TryParse<SourcePreset>(req.Preset, ignoreCase: true, out var preset))
            return Results.Problem($"Unknown source preset '{req.Preset}'.", statusCode: 400);

        try
        {
            // RequireScope for the refusal only: which copies this origin registers is the load
            // order's answer, read from the shared kernel rather than from the Index.
            index.RequireScope();
            var result = await trackHandler.TrackAsync(holder.Current, HeldCopies(index), req.Origin, preset);
            if (result.Applied)
                return Results.Ok(new TrackResponse(req.Origin));

            logger.LogWarning("Refused to track {Origin}: {Refusal} — {Message}", req.Origin, result.Refusal, result.Message);
            return WriteEndpointMapping.Refusal(result);
        }
        catch (NoLoadOrderException ex)
        {
            logger.LogError(ex, "No loadOrder when tracking {Origin}", req.Origin);
            return WriteEndpointMapping.NoLoadOrder(ex);
        }
    }

    // req.Ref, when given, is CompileSource.AtRef rather than the default WorkingTree — the
    // extension supplies "main" for the compile-at-main gesture, behind its own confirmation.
    internal static IResult Compile(string plugin, CompileRequest req, CompilePluginHandler compileHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        // The write touches a file inside a git working tree Modbench does not own exclusively
        // (root CLAUDE.md), so the I/O failure is shaped here rather than escaping as a bodyless 500.
        try
        {
            CompileSource source = req.Ref is { } gitRef ? new CompileSource.AtRef(gitRef) : new CompileSource.WorkingTree();
            var result = compileHandler.Compile(WriteEndpointMapping.PluginKeyOf(plugin, req.Origin), source);
            return Results.Ok(result);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not compile {Plugin}", decoded);
            return WriteEndpointMapping.WriteFailure($"Could not compile {decoded}: {ex.Message}");
        }
    }

    // FormKey null means auto-allocate; non-null is xEdit's typed-FormID path, validated
    // server-side either way. logReceived is null on purpose: no PluginEndpoints handler logs on
    // entry, UseSerilogRequestLogging's per-request summary covers it.
    internal static IResult CreateRecord(
        string plugin, RecordCreateRequest req, CreateRecordHandler edits, IndexWriteGate gate,
        ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        return WriteEndpointMapping.Execute(
            gate,
            logReceived: null,
            validate: () =>
            {
                if (string.IsNullOrWhiteSpace(req.Origin))
                    return Results.Problem("Origin is required.", statusCode: 400);
                if (string.IsNullOrWhiteSpace(req.RecordType))
                    return Results.Problem("A record type is required.", statusCode: 400);
                return null;
            },
            execute: () => edits.CreateRecord(WriteEndpointMapping.PluginKeyOf(plugin, req.Origin), req.RecordType, req.EditorId, req.FormKey),
            onApplied: result => Results.Ok(new RecordCreateResponse(true, result.NewFormKey!, req.RecordType)),
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

    // Best-effort origin: a load order that has reloaded away from a plugin still reports the
    // question with an empty Origin rather than dropping it, since the question is still real.
    internal static IResult ExternalChangeStatus(ExternalChangeWatcher watcher, IndexProjector index)
    {
        // Projected once, not per question: the whole list is answered against one value.
        var loadOrder = index.LoadOrder is { } held ? LoadOrder.From(held) : LoadOrder.Empty;
        var responses = watcher.Unanswered().Select(p =>
            new UnansweredExternalChangeResponse(
                p.PluginName, OriginOfExternalChange(loadOrder, p.ModFolder, p.PluginName),
                p.Classification.MetaChanged, p.Classification.OldVersion, p.Classification.NewVersion))
            .ToList();
        return Results.Ok(responses);
    }

    // Shared with ExternalChangeApplier's own notification and overflow paths, which start from the
    // same bare (modFolder, pluginName) identity the watcher carries.
    internal static string OriginOfExternalChange(LoadOrder loadOrder, string modFolder, string pluginName) =>
        loadOrder.Copies.FirstOrDefault(copy =>
            copy.Name.Equals(pluginName, StringComparison.OrdinalIgnoreCase)
            && ModFolders.Of(copy.Origin, copy.Path) == modFolder)?.Origin ?? "";

    // Absorb Upstream Update. The plugin name and origin resolve the target the same way
    // Compile does; GameRelease comes off the loaded load order, never guessed.
    internal static IResult AbsorbExternalChange(
        string plugin, ExternalChangeActionRequest req, IndexProjector index, AbsorbExternalChangeHandler handler,
        ExternalChangeWatcher watcher, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (matched, loadOrder) = ResolveAnyPhysicalCopy(index, req.Origin, decoded, logger);
        var modFolder = matched is null ? null : ModFolders.TrackedOf(loadOrder, new PluginKey(matched.Name, matched.Origin));
        if (modFolder is null)
            return Results.Problem($"{decoded} ({req.Origin}) is not a tracked plugin in the load order.", statusCode: 503);
        var pluginPath = matched!.Path;

        try
        {
            var result = handler.Absorb(modFolder, decoded, pluginPath, loadOrder);
            if (result.Applied)
            {
                watcher.MarkAnswered(modFolder, decoded);
                watcher.Watch(modFolder, decoded, pluginPath);
            }
            return Results.Ok(new ExternalChangeActionResponse(result.Applied, result.RefusalReason));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not absorb upstream update for {Plugin}", decoded);
            return WriteEndpointMapping.WriteFailure($"Could not absorb upstream update for {decoded}: {ex.Message}");
        }
    }

    // Keep as My Edit. A same-record collision is a typed refusal (ExternalChangeLandResult.
    // Applied == false), not an exception — it travels straight through as a 200, same posture as
    // Compile's own refusal.
    internal static IResult KeepExternalChange(
        string plugin, ExternalChangeActionRequest req, IndexProjector index, KeepExternalChangeHandler handler,
        ExternalChangeWatcher watcher, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (matched, loadOrder) = ResolveAnyPhysicalCopy(index, req.Origin, decoded, logger);
        var modFolder = matched is null ? null : ModFolders.TrackedOf(loadOrder, new PluginKey(matched.Name, matched.Origin));
        if (modFolder is null)
            return Results.Problem($"{decoded} ({req.Origin}) is not a tracked plugin in the load order.", statusCode: 503);
        var pluginPath = matched!.Path;

        try
        {
            var result = handler.Keep(
                modFolder, WriteEndpointMapping.PluginKeyOf(plugin, req.Origin), pluginPath, loadOrder.GameRelease);
            if (result.Applied)
            {
                watcher.MarkAnswered(modFolder, decoded);
                watcher.Watch(modFolder, decoded, pluginPath);
            }
            return Results.Ok(new ExternalChangeActionResponse(result.Applied, result.RefusalReason));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not keep external change for {Plugin}", decoded);
            return WriteEndpointMapping.WriteFailure($"Could not keep external change for {decoded}: {ex.Message}");
        }
    }

    // The offered rebase, origin-scoped — the repo is the unit of baselines and rebase, not
    // any one plugin inside it.
    internal static IResult Rebase(RebaseRequest req, IndexProjector index, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (matched, _) = ResolveAnyPhysicalCopy(index, req.Origin, pluginName: null, logger);
        if (matched is null || Path.GetDirectoryName(matched.Path) is not { } modFolder)
            return Results.Problem($"No loaded plugin has origin '{req.Origin}'.", statusCode: 404);

        var result = SourceRepository.RebaseEditBranch(modFolder);
        return Results.Ok(ToRebaseResponse(result));
    }

    internal static IResult ContinueRebase(RebaseRequest req, IndexProjector index, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (matched, _) = ResolveAnyPhysicalCopy(index, req.Origin, pluginName: null, logger);
        if (matched is null || Path.GetDirectoryName(matched.Path) is not { } modFolder)
            return Results.Problem($"No loaded plugin has origin '{req.Origin}'.", statusCode: 404);

        var result = SourceRepository.ContinueRebase(modFolder);
        return Results.Ok(ToRebaseResponse(result));
    }

    private static RebaseResponse ToRebaseResponse(RebaseResult result) =>
        new(result.Outcome, result.RefusalReason, result.ConflictedPaths);

    // Deliberately not PluginOriginResolver, which filters to load-order members: a copy shadowed
    // by a higher-priority mod of the same filename still has its question to answer. A null
    // pluginName means whichever plugin this origin holds.
    private static (RegisteredCopy? Plugin, LoadOrder LoadOrder) ResolveAnyPhysicalCopy(
        IndexProjector index, string origin, string? pluginName, ILogger logger)
    {
        var loadOrder = index.LoadOrder is { } held ? LoadOrder.From(held) : LoadOrder.Empty;
        var plugin = loadOrder.Copies.FirstOrDefault(p =>
            p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase)
            && (pluginName is null || p.Name.Equals(pluginName, StringComparison.OrdinalIgnoreCase)));
        if (plugin == null)
        {
            if (pluginName is null)
                logger.LogWarning("No loaded plugin has origin {Origin}", origin);
            else
                logger.LogWarning("No loaded plugin named {Plugin} with origin {Origin}", pluginName, origin);
            return (null, LoadOrder.Empty);
        }
        return (plugin, loadOrder);
    }
}

// Path/Origin are the destination Mod Management's QuickPick resolved (an existing mod, a
// freshly installed mod folder, or overwrite/) — the caller resolves which physical folder, the
// backend acts on it.
public record CreatePluginRequest(string Name, string Path, string Origin);

// Preset is the wire-safe string form of SourcePreset ("Edits"/"Everything") — no Plugin/Path
// needed: Origin alone is enough for TrackService to resolve every plugin sharing that mod folder.
public record TrackRequest(string Origin, string Preset);

public record TrackResponse(string Origin);

// Ref null means CompileSource.WorkingTree (the normal Save & Compile); a name (e.g. "main")
// means CompileSource.AtRef — no confirmation flag, that UX lives entirely on the extension side.
public record CompileRequest(string Origin, string? Ref);

// One queued external-change question, as the dialog needs it — MetaChanged/OldVersion/
// NewVersion are evidence the dialog must show, not hide, and MetaChanged alone (never acted on
// server-side) is what the extension uses to pick the default button.
public record UnansweredExternalChangeResponse(string Plugin, string Origin, bool MetaChanged, string? OldVersion, string? NewVersion);

// Absorb Upstream Update / Keep as My Edit both take just an origin — the plugin name already
// rides the route, matching CompileRequest's own shape.
public record ExternalChangeActionRequest(string Origin);

public record ExternalChangeActionResponse(bool Succeeded, string? RefusalReason);

// Origin-scoped — the repo is the unit of baselines and rebase.
public record RebaseRequest(string Origin);

// Outcome is the RebaseOutcome enum rather than a string so the OpenAPI schema, and the generated
// client, get the closed union. ConflictedPaths is the extension's cue to open each path in
// VS Code's merge editor.
public record RebaseResponse(RebaseOutcome Outcome, string? RefusalReason, IReadOnlyList<string> ConflictedPaths);
