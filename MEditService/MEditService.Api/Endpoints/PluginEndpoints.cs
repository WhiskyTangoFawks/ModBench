using MEditService.Bridge;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;

namespace MEditService.Api.Endpoints;

public static class PluginEndpoints
{
    private const string Tag = "Plugins";

    public static IEndpointRouteBuilder MapPluginEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/plugins", (IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            loggerFactory.CreateLogger(nameof(PluginEndpoints)).LogInformation("Received GetPlugins");
            return Results.Ok(svc.GetPlugins());
        })
            .WithName("GetPlugins")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginResponse>>();

        MapCatalog(app, "/record-types", "GetRecordTypes", svc => svc.GetRecordTypes());

        // The condition function picker's catalog (#152) — filtered to what the loaded session's
        // game actually resolves (ConditionCodecRegistry), not a hardcoded list.
        MapCatalog(app, "/condition-functions", "GetConditionFunctions", svc => svc.GetConditionFunctions());

        // The Run On target dropdown's catalog (#167) — filtered to what the loaded session's
        // game actually resolves (ConditionCodecRegistry), not a hardcoded frontend array.
        MapCatalog(app, "/condition-run-on-targets", "GetConditionRunOnTargets", svc => svc.GetConditionRunOnTargets());

        app.MapGet("/plugins/{plugin}/record-types", (string plugin, string? origin, IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            loggerFactory.CreateLogger(nameof(PluginEndpoints)).LogInformation("Received GetPluginRecordTypes for {Plugin} ({Origin})", plugin, origin);
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
                "Creates a new plugin at the given path/origin (#288 / ADR-0041), Tracking that " +
                "destination under the Edits preset first if it is not already tracked. Does NOT " +
                "add the plugin to any load order — the caller (the extension's Mod Management " +
                "writer, or a script/agent consumer per ADR-0024) is responsible for that.")
            .Produces<PluginResponse>()
            .ProducesProblem(400)
            .ProducesProblem(409)
            .ProducesProblem(500)
            .ProducesProblem(503);

        app.MapPost("/plugins/load", LoadUnlistedPlugin)
            .WithName("LoadUnlistedPlugin")
            .WithTags(Tag)
            .Produces<PluginResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(503);

        app.MapPost("/plugins/unload", UnloadUnlistedPlugin)
            .WithName("UnloadUnlistedPlugin")
            .WithTags(Tag)
            .Produces(204)
            .ProducesProblem(400)
            .ProducesProblem(409)
            .ProducesProblem(503);

        app.MapPost("/plugins/reread", RereadPlugin)
            .WithName("RereadPlugin")
            .WithTags(Tag)
            .Produces<PluginResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(503);

        app.MapPost("/plugins/track", Track)
            .WithName("Track")
            .WithTags(Tag)
            .Produces<TrackResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(500)
            .ProducesProblem(503);

        // #414 review F2: polled alongside the still in-flight POST /plugins/track, same idiom
        // GET /session/status already established for the session load — always 200 (TrackProgress.
        // Idle when nothing is running), no session dependency, since progress lives on the
        // singleton TrackService itself.
        app.MapGet("/plugins/track/status", (TrackService trackService, ILoggerFactory loggerFactory) =>
        {
            loggerFactory.CreateLogger(nameof(PluginEndpoints)).LogTrace("Received GetTrackStatus");
            return Results.Ok(trackService.Progress);
        })
            .WithName("GetTrackStatus")
            .WithTags(Tag)
            .Produces<TrackProgress>();

        // #416: Save & Compile's own door — a plugin and, optionally, a git ref (CompileSource.AtRef,
        // e.g. "main"). No "confirmed" flag: the compile-at-main modal is extension-side UX (#416
        // review comment 2 on the go-ahead) — a backend gate on a confirmation boolean would be UX
        // leaking through the wire. Refusal is a typed, successful response (CompileResult.Succeeded
        // == false), never an HTTP error status — 200 either way, matching the pinned contract's own
        // "refusal is a typed result, not an exception".
        app.MapPost("/plugins/{plugin}/compile", Compile)
            .WithName("CompilePlugin")
            .WithTags(Tag)
            .Produces<CompileResult>()
            .ProducesProblem(400)
            .ProducesProblem(500);

        // #427: create-record — the plugin hosts the new group, so it owns the route the way Compile
        // does; the FormKey doesn't exist yet, which is exactly why this isn't under /records/{formKey}.
        // Same route shape a retired pending-change-era endpoint once had (RetiredEditingWireSurfaceTests
        // used to pin it absent); the summary/description below carry the "same string, new meaning"
        // distinction onto the surface itself, not just a test comment.
        app.MapPost("/plugins/{plugin}/records", CreateRecord)
            .WithName("CreateRecord")
            .WithSummary("Create a new record as a working-tree change (#427).")
            .WithDescription(
                "Mints a new record and writes it as a new source file in the plugin's working tree — " +
                "a git-native create, answering at Effective only until committed and compiled. Not the " +
                "retired pending-change-era create this same route once served; that mechanism (staged " +
                "rows, no source text) was removed with ADR-0041/#410.")
            .WithTags(Tag)
            .Produces<RecordCreateResponse>()
            .ProducesProblem(400)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(500)
            .ProducesProblem(503);

        // #427: a read-only peek at what CreateRecord/RenumberRecord would auto-allocate — feeds the
        // Renumber gesture's FormID input box a suggested default (xEdit's own "New FormID
        // generated" flow), never a write, no tracked gate (pure arithmetic over indexed state).
        // Review finding #2: brought to the same typed-refusal standard as its siblings (no session,
        // FormKey space exhausted) via the same RecordEditResult/Refusal mapping they use, rather
        // than a bespoke nullable-string contract with no way to distinguish the two.
        app.MapGet("/plugins/{plugin}/records/next-form-key", (
            string plugin, string origin, RecordEditService edits, ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
            var decoded = Uri.UnescapeDataString(plugin);
            logger.LogInformation("Received PeekNextFreeFormKey for {Plugin} ({Origin})", decoded, origin);
            var result = edits.PeekNextFreeFormKey(new PluginKey(decoded, origin));
            return result.Applied ? Results.Ok(new NextFreeFormKeyResponse(result.NewFormKey!)) : RecordEndpoints.Refusal(result);
        })
            .WithName("PeekNextFreeFormKey")
            .WithTags(Tag)
            .Produces<NextFreeFormKeyResponse>()
            .ProducesProblem(404)
            .ProducesProblem(422);

        // #417: polled the same way GET /plugins/track/status is — always 200, an empty list when
        // nothing is pending, no session dependency of its own (the watcher's queue lives on the
        // singleton ExternalChangeWatcher, same idiom as TrackService.Progress).
        app.MapGet("/plugins/external-changes/status", ExternalChangeStatus)
            .WithName("GetExternalChangeStatus")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PendingExternalChangeResponse>>();

        // #417: Absorb Upstream Update. 200 either way — a refusal here is the same typed-result
        // posture Compile already established, not an HTTP error a client has to distinguish from a
        // transport failure.
        app.MapPost("/plugins/{plugin}/external-change/absorb", AbsorbExternalChange)
            .WithName("AbsorbExternalChange")
            .WithTags(Tag)
            .Produces<ExternalChangeActionResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        // #417: Keep as My Edit. Same-record collision is ExternalChangeActionResponse.Succeeded ==
        // false with RefusalReason naming the records — never an HTTP error.
        app.MapPost("/plugins/{plugin}/external-change/keep", KeepExternalChange)
            .WithName("KeepExternalChange")
            .WithTags(Tag)
            .Produces<ExternalChangeActionResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        // #417: the offered rebase, and its re-runnable form (Modbench: Rebase onto Updated
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

    // Shared shape for the /record-types, /condition-functions and /condition-run-on-targets
    // catalog endpoints (#244): log receipt, run the read against the loaded session, and map the
    // "no session loaded" failure (RequireSession()'s InvalidOperationException) to the same 503
    // CreatePlugin's own catch below uses.
    private static void MapCatalog(
        IEndpointRouteBuilder app, string route, string name, Func<IRecordQueryService, IReadOnlyList<string>> getCatalog)
    {
        app.MapGet(route, (IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
            logger.LogInformation("Received {Name}", name);
            try
            {
                return Results.Ok(getCatalog(svc));
            }
            catch (InvalidOperationException ex)
            {
                logger.LogError(ex, "No session for {Name}", name);
                return Results.Problem(ex.Message, statusCode: 503);
            }
        })
            .WithName(name)
            .WithTags("Records")
            .Produces<IReadOnlyList<string>>()
            .ProducesProblem(503);
    }

    // #34 / ADR-0035: loads a plugin file the effective load order does not name. The caller
    // (Mod Management, which owns mods/ and the file-conflict merge) supplies the physical path
    // and the origin it resolved the file from; the session decides everything else, since
    // read-only-ness and non-participation are properties of not being in the load order, not
    // choices a caller makes.
    internal static IResult LoadUnlistedPlugin(LoadPluginRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received LoadUnlistedPlugin for {Path} from {Origin}", req.Path, req.Origin);
        if (string.IsNullOrWhiteSpace(req.Path) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Plugin path and origin are required.", statusCode: 400);

        try
        {
            return Results.Ok(sessionManager.LoadUnlistedPlugin(req.Path, req.Origin));
        }
        catch (FileNotFoundException ex)
        {
            logger.LogError(ex, "Unlisted plugin file not found: {Path}", req.Path);
            return Results.Problem(ex.Message, statusCode: 404);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No session when loading unlisted plugin {Path}", req.Path);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    internal static IResult UnloadUnlistedPlugin(UnloadPluginRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received UnloadUnlistedPlugin for {Plugin} from {Origin}", req.Plugin, req.Origin);
        if (string.IsNullOrWhiteSpace(req.Plugin) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Plugin name and origin are required.", statusCode: 400);

        try
        {
            sessionManager.UnloadUnlistedPlugin(req.Plugin, req.Origin);
            return Results.NoContent();
        }
        catch (KeyNotFoundException ex)
        {
            // 409, not 404: the common way to reach this is naming a plugin that *is* loaded but is
            // a load-order member, which is a conflict with what that plugin is, not a missing
            // resource. Only the toggle's own copies are unloadable.
            logger.LogWarning(ex, "Refused to unload {Plugin} from {Origin}", req.Plugin, req.Origin);
            return Results.Problem(ex.Message, statusCode: 409);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No session when unloading {Plugin}", req.Plugin);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    // #279 / ADR-0035 § Live mutation: re-reads one plugin from the copy a mod-level change has
    // made its name resolve to. Same division of labour as LoadUnlistedPlugin above — Mod
    // Management owns "which file does this name resolve to" and states the answer, because the
    // session cannot map a filename to a mod folder and must never learn how.
    internal static IResult RereadPlugin(RereadPluginRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received RereadPlugin for {Plugin} from {Origin}", req.Plugin, req.Origin);
        if (string.IsNullOrWhiteSpace(req.Plugin) || string.IsNullOrWhiteSpace(req.Path) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Plugin name, path and origin are required.", statusCode: 400);

        try
        {
            return Results.Ok(sessionManager.RereadPlugin(req.Plugin, req.Path, req.Origin));
        }
        catch (SessionBusyException ex)
        {
            // 409, consistent with the session-load contract's own superseded-load answer: nothing
            // went wrong and nothing was touched — the same request is answerable once the load
            // lands. Caught before InvalidOperationException deliberately; see SessionBusyException
            // for why it is not a subclass of one.
            logger.LogWarning(ex, "Refused to re-read {Plugin} while a load is in flight", req.Plugin);
            return Results.Problem(ex.Message, statusCode: 409);
        }
        catch (FileNotFoundException ex)
        {
            logger.LogWarning(ex, "Re-read target not found for {Plugin}: {Path}", req.Plugin, req.Path);
            return Results.Problem(ex.Message, statusCode: 404);
        }
        catch (KeyNotFoundException ex)
        {
            // 404, unlike /plugins/unload's 409: the only way here is naming a plugin the load
            // order does not have, which is a missing resource rather than a conflict with what
            // the named plugin is.
            logger.LogWarning(ex, "No load-order plugin {Plugin} to re-read", req.Plugin);
            return Results.Problem(ex.Message, statusCode: 404);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No session when re-reading {Plugin}", req.Plugin);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    // #288 / ADR-0041: creates a plugin at a caller-resolved destination (Mod Management's
    // destination QuickPick — overwrite/, an existing mod, or a freshly installed mod folder) and,
    // when that destination is untracked, Tracks it as part of the same gesture under the Edits
    // preset — silently, and always Edits: the one-keystroke "Enter accepts overwrite/" framing
    // this gesture is built around rules out a second prompt here, and Edits is Track's own
    // default. A user who wants a different preset deletes .git and re-Tracks by hand, same as
    // changing a Track preset anywhere else.
    //
    // Deliberately does not touch plugins.txt — #288 moved that append to the caller (see
    // .WithDescription above); this handler's job ends at "the plugin exists, is indexed, and is
    // editable."
    internal static async Task<IResult> CreatePlugin(
        CreatePluginRequest req, ISessionManager sessionManager, TrackService trackService, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received CreatePlugin for {Name} at {Path} ({Origin})", req.Name, req.Path, req.Origin);
        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.Problem("Plugin name is required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(req.Path) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Destination path and origin are required.", statusCode: 400);

        try
        {
            var plugin = sessionManager.CreatePlugin(req.Name, req.Path, req.Origin);

            if (!SourceRepository.IsTracked(req.Path))
                await trackService.TrackAsync(sessionManager.Session!, req.Origin, SourcePreset.Edits);

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
        catch (SourceAlreadyTrackedException ex)
        {
            // Defensive, not the ordinary path: CreatePlugin only Tracks a destination it just
            // checked was untracked, so reaching this means something else tracked the same folder
            // in the window between that check and this call — still a state conflict, same status
            // the Track endpoint itself uses for a redundant Track.
            logger.LogWarning(ex, "Raced tracking {Origin} while creating {Name}", req.Origin, req.Name);
            return Results.Problem(ex.Message, statusCode: 409);
        }
        catch (GitUnavailableException ex)
        {
            // Loud, not silent: the plugin file and session entry from the CreatePlugin call above
            // already landed, but plugins.txt is never appended without a 2xx response (the caller's
            // own gate), so no load order can ever name this half-created plugin. The orphaned
            // session entry is accepted residue (#288 review), surfaced here rather than swallowed.
            logger.LogError(ex, "git unavailable while creating {Name} in {Origin}", req.Name, req.Origin);
            return Results.Problem(ex.Message, statusCode: 500);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No session when creating plugin {Name}", req.Name);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    // #414/ADR-0041: the Track gesture. Origin names the mod folder (every loaded plugin sharing
    // it gets tracked together — a mod can hold more than one plugin); the session resolves which
    // physical folder that is, same division of labour as RereadPlugin/LoadUnlistedPlugin above.
    internal static async Task<IResult> Track(TrackRequest req, ISessionManager sessionManager, TrackService trackService, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received Track for {Origin} ({Preset})", req.Origin, req.Preset);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);
        if (!Enum.TryParse<SourcePreset>(req.Preset, ignoreCase: true, out var preset))
            return Results.Problem($"Unknown source preset '{req.Preset}'.", statusCode: 400);

        if (sessionManager.Session is not { } session)
        {
            logger.LogError("No session when tracking {Origin}", req.Origin);
            return Results.Problem("No session loaded.", statusCode: 503);
        }

        try
        {
            await trackService.TrackAsync(session, req.Origin, preset);
            return Results.Ok(new TrackResponse(req.Origin));
        }
        catch (KeyNotFoundException ex)
        {
            logger.LogWarning(ex, "No loaded plugin has origin {Origin} to track", req.Origin);
            return Results.Problem(ex.Message, statusCode: 404);
        }
        catch (SourceAlreadyTrackedException ex)
        {
            logger.LogWarning(ex, "Refused to re-track {Origin}", req.Origin);
            return Results.Problem(ex.Message, statusCode: 409);
        }
        catch (GitUnavailableException ex)
        {
            logger.LogError(ex, "git unavailable while tracking {Origin}", req.Origin);
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    // #416: Save & Compile. plugin/origin name the target the same way every other plugin-scoped
    // door here does; req.Ref, when given, is CompileSource.AtRef rather than the default
    // CompileSource.WorkingTree — the extension supplies "main" for the compile-at-main gesture,
    // behind its own confirmation, never a flag on this request.
    internal static IResult Compile(string plugin, CompileRequest req, PluginCompileService compileService, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        logger.LogInformation("Received Compile for {Plugin} ({Origin}) at {Ref}", decoded, req.Origin, req.Ref ?? "(working tree)");

        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        // The write path touches a file inside a live git working tree Modbench does not own
        // exclusively (root CLAUDE.md) — same posture as RecordEndpoints.EditField's own catch, this
        // door's write-side equivalent, rather than a bodyless 500 a client can't tell apart from the
        // backend having died.
        try
        {
            CompileSource source = req.Ref is { } gitRef ? new CompileSource.AtRef(gitRef) : new CompileSource.WorkingTree();
            var result = compileService.Compile(new PluginKey(decoded, req.Origin), source);
            return Results.Ok(result);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not compile {Plugin}", decoded);
            return Results.Problem($"Could not compile {decoded}: {ex.Message}", statusCode: 500);
        }
    }

    // #427: create-record. FormKey null means auto-allocate (both-refs collision-safe); non-null is
    // xEdit's typed-FormID path, validated server-side either way (RecordEditRefusal.FormKeyCollision).
    internal static IResult CreateRecord(string plugin, RecordCreateRequest req, RecordEditService edits, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        logger.LogInformation(
            "Received CreateRecord for {RecordType} in {Plugin} ({Origin})", req.RecordType, decoded, req.Origin);

        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(req.RecordType))
            return Results.Problem("A record type is required.", statusCode: 400);

        try
        {
            var result = edits.CreateRecord(new PluginKey(decoded, req.Origin), req.RecordType, req.EditorId, req.FormKey);
            return result.Applied
                ? Results.Ok(new RecordCreateResponse(true, result.NewFormKey!, req.RecordType))
                : RecordEndpoints.Refusal(result);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not write the source file while creating a {RecordType} in {Plugin}", req.RecordType, decoded);
            return Results.Problem($"Could not write the source file for the new record: {ex.Message}", statusCode: 500);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No usable session while creating a record in {Plugin}", decoded);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    // #417: the watcher's own queue plus (best-effort) the origin each pending plugin currently
    // resolves to in the loaded session — a session that has since reloaded away from a plugin still
    // reports the question with an empty Origin rather than dropping it, since the question itself
    // is still real and unanswered regardless of what's loaded right now.
    internal static IResult ExternalChangeStatus(ExternalChangeWatcher watcher, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(PluginEndpoints)).LogTrace("Received GetExternalChangeStatus");
        var session = sessionManager.Session;
        var responses = watcher.Pending().Select(p =>
        {
            var origin = session?.Plugins.FirstOrDefault(pl =>
                pl.Name.Equals(p.PluginName, StringComparison.OrdinalIgnoreCase)
                && ModFolders.Of(pl.Origin, pl.Path) == p.ModFolder)?.Origin ?? "";
            return new PendingExternalChangeResponse(p.PluginName, origin, p.Classification.MetaChanged, p.Classification.OldVersion, p.Classification.NewVersion);
        }).ToList();
        return Results.Ok(responses);
    }

    // #417: Absorb Upstream Update. The plugin name and origin resolve the target the same way
    // Compile does; GameRelease comes off the loaded session, never guessed.
    internal static IResult AbsorbExternalChange(string plugin, ExternalChangeActionRequest req, ISessionManager sessionManager, ExternalChangeWatcher watcher, ISchemaReflector reflector, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        logger.LogInformation("Received AbsorbExternalChange for {Plugin} ({Origin})", decoded, req.Origin);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (modFolder, pluginPath, session) = ResolvePluginPath(sessionManager, decoded, req.Origin, logger);
        if (modFolder is null)
            return Results.Problem($"{decoded} ({req.Origin}) is not a tracked plugin in the loaded session.", statusCode: 503);

        try
        {
            ExternalChangeAbsorber.Absorb(modFolder, decoded, pluginPath!, session!.GameRelease, reflector);
            watcher.ClearPending(modFolder, decoded);
            watcher.Watch(modFolder, decoded, pluginPath!);
            return Results.Ok(new ExternalChangeActionResponse(true, null));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not absorb upstream update for {Plugin}", decoded);
            return Results.Problem($"Could not absorb upstream update for {decoded}: {ex.Message}", statusCode: 500);
        }
    }

    // #417: Keep as My Edit. A same-record collision is a typed refusal (ExternalChangeLandResult.
    // Applied == false), not an exception — it travels straight through as a 200, same posture as
    // Compile's own refusal.
    internal static IResult KeepExternalChange(string plugin, ExternalChangeActionRequest req, ISessionManager sessionManager, ExternalChangeWatcher watcher, ISchemaReflector reflector, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        logger.LogInformation("Received KeepExternalChange for {Plugin} ({Origin})", decoded, req.Origin);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (modFolder, pluginPath, session) = ResolvePluginPath(sessionManager, decoded, req.Origin, logger);
        if (modFolder is null)
            return Results.Problem($"{decoded} ({req.Origin}) is not a tracked plugin in the loaded session.", statusCode: 503);

        try
        {
            var result = ExternalChangeEditLander.Keep(modFolder, decoded, pluginPath!, session!.GameRelease, reflector);
            if (result.Applied)
            {
                watcher.ClearPending(modFolder, decoded);
                watcher.Watch(modFolder, decoded, pluginPath!);
            }
            return Results.Ok(new ExternalChangeActionResponse(result.Applied, result.RefusalReason));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not keep external change for {Plugin}", decoded);
            return Results.Problem($"Could not keep external change for {decoded}: {ex.Message}", statusCode: 500);
        }
    }

    // #417: the offered rebase, origin-scoped — the repo is the unit of baselines and rebase, not
    // any one plugin inside it.
    internal static IResult Rebase(RebaseRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received RebaseEditBranch for {Origin}", req.Origin);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        if (ResolveModFolder(sessionManager, req.Origin, logger) is not { } modFolder)
            return Results.Problem($"No loaded plugin has origin '{req.Origin}'.", statusCode: 404);

        var result = SourceRepository.RebaseEditBranch(modFolder);
        return Results.Ok(ToRebaseResponse(result));
    }

    internal static IResult ContinueRebase(RebaseRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received ContinueRebaseEditBranch for {Origin}", req.Origin);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        if (ResolveModFolder(sessionManager, req.Origin, logger) is not { } modFolder)
            return Results.Problem($"No loaded plugin has origin '{req.Origin}'.", statusCode: 404);

        var result = SourceRepository.ContinueRebase(modFolder);
        return Results.Ok(ToRebaseResponse(result));
    }

    private static RebaseResponse ToRebaseResponse(RebaseResult result) =>
        new(result.Outcome.ToString(), result.RefusalReason, result.ConflictedPaths);

    // Deliberately not PluginOriginResolver.Resolve — that resolver filters to load-order members
    // only (by design, so a bare filename stays a safe write target), but #417's origin-scoped
    // gestures must still resolve a shadowed copy: a plugin loaded under this origin but shadowed
    // by a higher-priority mod of the same filename is exactly a mod whose external-change
    // question, absorb, keep, or rebase still needs answering.
    private static string? ResolveModFolder(ISessionManager sessionManager, string origin, ILogger logger)
    {
        var plugin = sessionManager.Session?.Plugins.FirstOrDefault(p => p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase));
        if (plugin == null)
        {
            logger.LogWarning("No loaded plugin has origin {Origin}", origin);
            return null;
        }
        return Path.GetDirectoryName(plugin.Path);
    }

    // Same reason ResolveModFolder above doesn't reuse PluginOriginResolver.Resolve: this must
    // still find a plugin shadowed out of the load order, since that copy is exactly what
    // absorb/keep target when it's the one whose origin the pending question named.
    private static (string? ModFolder, string? PluginPath, IGameSession? Session) ResolvePluginPath(
        ISessionManager sessionManager, string pluginName, string origin, ILogger logger)
    {
        var session = sessionManager.Session;
        var plugin = session?.Plugins.FirstOrDefault(p =>
            p.Name.Equals(pluginName, StringComparison.OrdinalIgnoreCase) && p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase));
        if (plugin == null)
        {
            logger.LogWarning("No loaded plugin named {Plugin} with origin {Origin}", pluginName, origin);
            return (null, null, null);
        }
        var modFolder = ModFolders.TrackedOf(session, new PluginKey(plugin.Name, plugin.Origin));
        return (modFolder, plugin.Path, session);
    }
}

// #288: Path/Origin are the destination Mod Management's QuickPick resolved (an existing mod, a
// freshly installed mod folder, or overwrite/) — matching LoadPluginRequest's own shape, since the
// division of labour is the same: the caller resolves which physical folder, the backend acts on it.
public record CreatePluginRequest(string Name, string Path, string Origin);

public record LoadPluginRequest(string Path, string Origin);

public record UnloadPluginRequest(string Plugin, string Origin);

// #279: Path and Origin are the copy the plugin name resolves to *now*, resolved by Mod
// Management. Plugin is the filename, which is what the load order names and what does not change.
public record RereadPluginRequest(string Plugin, string Path, string Origin);

// #414: Preset is the wire-safe string form of SourcePreset ("Edits"/"Everything") — Plugin/Path
// aren't needed here, unlike RereadPluginRequest's: Origin alone is enough for TrackService to
// resolve every plugin sharing that mod folder.
public record TrackRequest(string Origin, string Preset);

public record TrackResponse(string Origin);

// #416: Ref null means CompileSource.WorkingTree (the normal Save & Compile); a name (e.g. "main")
// means CompileSource.AtRef — no confirmation flag, that UX lives entirely on the extension side.
public record CompileRequest(string Origin, string? Ref);

// #417: one queued external-change question, as the dialog needs it — MetaChanged/OldVersion/
// NewVersion are the evidence the pinned UX contract says must be shown, not hidden, and
// MetaChanged alone (never acted on server-side) is what the extension uses to pick the default
// button.
public record PendingExternalChangeResponse(string Plugin, string Origin, bool MetaChanged, string? OldVersion, string? NewVersion);

// #417: Absorb Upstream Update / Keep as My Edit both take just an origin — the plugin name already
// rides the route, matching CompileRequest's own shape.
public record ExternalChangeActionRequest(string Origin);

public record ExternalChangeActionResponse(bool Succeeded, string? RefusalReason);

// #417: origin-scoped — the repo is the unit of baselines and rebase.
public record RebaseRequest(string Origin);

// #417: Outcome is RebaseOutcome's wire-safe string form ("Clean"/"Refused"/"Conflicted").
// ConflictedPaths is the extension's cue to open each path in VS Code's native merge editor.
public record RebaseResponse(string Outcome, string? RefusalReason, IReadOnlyList<string> ConflictedPaths);
