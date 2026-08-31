using MEditService.Bridge;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
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

        MapCatalog(app, "/record-types", "GetRecordTypes", svc => svc.GetRecordTypes());

        // The condition function picker's catalog — filtered to what the loaded load order's
        // game actually resolves (ConditionCodecRegistry), not a hardcoded list.
        MapCatalog(app, "/condition-functions", "GetConditionFunctions", svc => svc.GetConditionFunctions());

        // The Run On target dropdown's catalog — filtered to what the loaded load order's
        // game actually resolves (ConditionCodecRegistry), not a hardcoded frontend array.
        MapCatalog(app, "/condition-run-on-targets", "GetConditionRunOnTargets", svc => svc.GetConditionRunOnTargets());

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

        // Polled alongside the still in-flight POST /plugins/track, same idiom
        // GET /load-order/status already established for the reconcile — always 200 (TrackProgress.
        // Idle when nothing is running), no load order dependency, since progress lives on the
        // singleton TrackService itself.
        app.MapGet("/plugins/track/status", (TrackService trackService) => Results.Ok(trackService.Progress))
            .WithName("GetTrackStatus")
            .WithTags(Tag)
            .Produces<TrackProgress>();

        // Save & Compile's own door — a plugin and, optionally, a git ref (CompileSource.AtRef,
        // e.g. "main"). No "confirmed" flag: the compile-at-main modal is extension-side UX — a
        // backend gate on a confirmation boolean would be UX leaking through the wire. Refusal is a
        // typed, successful response (CompileResult.Succeeded == false), never an HTTP error
        // status — 200 either way.
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

        // A read-only peek at what CreateRecord/RenumberRecord would auto-allocate — feeds the
        // Renumber gesture's FormID input box a suggested default (xEdit's own "New FormID
        // generated" flow), never a write, no tracked gate (pure arithmetic over indexed state).
        // Refusals (no load order, FormKey space exhausted) go through the same
        // RecordEditResult/Refusal mapping its siblings use, rather than a bespoke nullable-string
        // contract with no way to distinguish the two.
        app.MapGet("/plugins/{plugin}/records/next-form-key", (
            string plugin, string origin, RecordEditService edits) =>
        {
            var result = edits.PeekNextFreeFormKey(WriteEndpointMapping.PluginKeyOf(plugin, origin));
            return result.Applied ? Results.Ok(new NextFreeFormKeyResponse(result.NewFormKey!)) : WriteEndpointMapping.Refusal(result);
        })
            .WithName("PeekNextFreeFormKey")
            .WithTags(Tag)
            .Produces<NextFreeFormKeyResponse>()
            .ProducesProblem(404)
            .ProducesProblem(422);

        // Polled the same way GET /plugins/track/status is — always 200, an empty list when
        // nothing is unanswered, no load order dependency of its own (the watcher's queue lives on the
        // singleton ExternalChangeWatcher, same idiom as TrackService.Progress).
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

    // Shared shape for the /record-types, /condition-functions and /condition-run-on-targets
    // catalog endpoints: run the read against the loaded load order, and map the
    // "no load order held" failure (RequireLoadOrder()'s InvalidOperationException) to the same 503
    // CreatePlugin's own catch below uses.
    private static void MapCatalog(
        IEndpointRouteBuilder app, string route, string name, Func<IRecordQueryService, IReadOnlyList<string>> getCatalog)
    {
        app.MapGet(route, (IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
            try
            {
                return Results.Ok(getCatalog(svc));
            }
            catch (InvalidOperationException ex)
            {
                logger.LogError(ex, "No loadOrder for {Name}", name);
                return Results.Problem(ex.Message, statusCode: 503);
            }
        })
            .WithName(name)
            .WithTags("Records")
            .Produces<IReadOnlyList<string>>()
            .ProducesProblem(503);
    }

    // ADR-0041: creates a plugin at a caller-resolved destination (Mod Management's
    // destination QuickPick — overwrite/, an existing mod, or a freshly installed mod folder) and,
    // when that destination is untracked, Tracks it as part of the same gesture under the Edits
    // preset — silently, and always Edits: the one-keystroke "Enter accepts overwrite/" framing
    // this gesture is built around rules out a second prompt here, and Edits is Track's own
    // default. A user who wants a different preset deletes .git and re-Tracks by hand, same as
    // changing a Track preset anywhere else.
    //
    // Deliberately does not touch plugins.txt — that append is the caller's (see .WithDescription
    // above); this handler's job ends at "the plugin exists, is indexed, and is editable."
    internal static async Task<IResult> CreatePlugin(
        CreatePluginRequest req, ILoadOrderMirror mirror, TrackService trackService, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.Problem("Plugin name is required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(req.Path) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Destination path and origin are required.", statusCode: 400);

        try
        {
            var plugin = mirror.CreatePlugin(req.Name, req.Path, req.Origin);

            if (!SourceRepository.IsTracked(req.Path))
                await trackService.TrackAsync(mirror.LoadOrder!, req.Origin, SourcePreset.Edits);

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
            // Loud, not silent: the plugin file and load order entry from the CreatePlugin call above
            // already landed, but plugins.txt is never appended without a 2xx response (the caller's
            // own gate), so no load order can ever name this half-created plugin. The orphaned
            // load order entry is accepted residue, surfaced here rather than swallowed.
            logger.LogError(ex, "git unavailable while creating {Name} in {Origin}", req.Name, req.Origin);
            return Results.Problem(ex.Message, statusCode: 500);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No loadOrder when creating plugin {Name}", req.Name);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    // ADR-0041: the Track gesture. Origin names the mod folder (every loaded plugin sharing
    // it gets tracked together — a mod can hold more than one plugin); the load order resolves
    // which physical folder that is.
    internal static async Task<IResult> Track(TrackRequest req, ILoadOrderMirror mirror, TrackService trackService, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);
        if (!Enum.TryParse<SourcePreset>(req.Preset, ignoreCase: true, out var preset))
            return Results.Problem($"Unknown source preset '{req.Preset}'.", statusCode: 400);

        try
        {
            var (loadOrder, _) = mirror.RequireScope();
            await trackService.TrackAsync(loadOrder, req.Origin, preset);
            return Results.Ok(new TrackResponse(req.Origin));
        }
        catch (NoLoadOrderException ex)
        {
            logger.LogError(ex, "No loadOrder when tracking {Origin}", req.Origin);
            return WriteEndpointMapping.NoLoadOrder(ex);
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
        // ADR-0042 decision 2: a data-quality problem with the plugin itself, not a state
        // conflict (409 is already spoken for by "this mod folder is already tracked") — 422 is the
        // status Compile's own refusal already uses for the same kind of "understood, but cannot be
        // processed" answer.
        catch (SourceRoundTripFailedException ex)
        {
            logger.LogWarning(ex, "Refused to track {Origin}: round-trip gate failed", req.Origin);
            return Results.Problem(ex.Message, statusCode: 422);
        }
        // Same status as the round-trip gate above — a data-quality problem with the
        // plugin itself (a missing strings file), not a state conflict.
        catch (MissingLocalizationStringsException ex)
        {
            logger.LogWarning(ex, "Refused to track {Origin}: missing localization strings", req.Origin);
            return Results.Problem(ex.Message, statusCode: 422);
        }
        catch (GitUnavailableException ex)
        {
            logger.LogError(ex, "git unavailable while tracking {Origin}", req.Origin);
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    // Save & Compile. plugin/origin name the target the same way every other plugin-scoped
    // door here does; req.Ref, when given, is CompileSource.AtRef rather than the default
    // CompileSource.WorkingTree — the extension supplies "main" for the compile-at-main gesture,
    // behind its own confirmation, never a flag on this request.
    internal static IResult Compile(string plugin, CompileRequest req, PluginCompileService compileService, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        // The write path touches a file inside a live git working tree Modbench does not own
        // exclusively (root CLAUDE.md) — same posture as RecordEndpoints.EditField's own catch, this
        // door's write-side equivalent, rather than a bodyless 500 a client can't tell apart from the
        // backend having died.
        try
        {
            CompileSource source = req.Ref is { } gitRef ? new CompileSource.AtRef(gitRef) : new CompileSource.WorkingTree();
            var result = compileService.Compile(WriteEndpointMapping.PluginKeyOf(plugin, req.Origin), source);
            return Results.Ok(result);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not compile {Plugin}", decoded);
            return WriteEndpointMapping.WriteFailure($"Could not compile {decoded}: {ex.Message}");
        }
    }

    // Create-record. FormKey null means auto-allocate (both-refs collision-safe); non-null is
    // xEdit's typed-FormID path, validated server-side either way (RecordEditRefusal.FormKeyCollision).
    internal static IResult CreateRecord(string plugin, RecordCreateRequest req, RecordEditService edits, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(req.RecordType))
            return Results.Problem("A record type is required.", statusCode: 400);

        try
        {
            var result = edits.CreateRecord(WriteEndpointMapping.PluginKeyOf(plugin, req.Origin), req.RecordType, req.EditorId, req.FormKey);
            return result.Applied
                ? Results.Ok(new RecordCreateResponse(true, result.NewFormKey!, req.RecordType))
                : WriteEndpointMapping.Refusal(result);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not write the source file while creating a {RecordType} in {Plugin}", req.RecordType, decoded);
            return WriteEndpointMapping.WriteFailure($"Could not write the source file for the new record: {ex.Message}");
        }
        // xEdit's own typed-FormID path (req.FormKey) reaches Mutagen's FormKey.Factory
        // (RecordEditService.RefuseIfNotNativeTarget) with no TryFactory guard — a malformed value
        // (wrong shape, non-hex, missing ':') throws ArgumentException there. Malformed syntax, not a
        // well-formed-but-refused RecordEditRefusal, so this is CreatePlugin's own catch shape (400),
        // never WriteEndpointMapping.Refusal's 422.
        catch (ArgumentException ex)
        {
            logger.LogError(ex, "Malformed FormKey creating a {RecordType} in {Plugin}", req.RecordType, decoded);
            return WriteEndpointMapping.MalformedFormKey(ex);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No usable loadOrder while creating a record in {Plugin}", decoded);
            return WriteEndpointMapping.NoLoadOrder(ex);
        }
    }

    // The watcher's own queue plus (best-effort) the origin each unanswered plugin currently
    // resolves to in the loaded load order — a load order that has since reloaded away from a plugin still
    // reports the question with an empty Origin rather than dropping it, since the question itself
    // is still real and unanswered regardless of what's loaded right now.
    internal static IResult ExternalChangeStatus(ExternalChangeWatcher watcher, ILoadOrderMirror mirror)
    {
        var loadOrder = mirror.LoadOrder;
        var responses = watcher.Unanswered().Select(p =>
        {
            var origin = loadOrder?.Plugins.FirstOrDefault(pl =>
                pl.Name.Equals(p.PluginName, StringComparison.OrdinalIgnoreCase)
                && ModFolders.Of(pl.Origin, pl.Path) == p.ModFolder)?.Origin ?? "";
            return new UnansweredExternalChangeResponse(p.PluginName, origin, p.Classification.MetaChanged, p.Classification.OldVersion, p.Classification.NewVersion);
        }).ToList();
        return Results.Ok(responses);
    }

    // Absorb Upstream Update. The plugin name and origin resolve the target the same way
    // Compile does; GameRelease comes off the loaded load order, never guessed.
    internal static IResult AbsorbExternalChange(string plugin, ExternalChangeActionRequest req, ILoadOrderMirror mirror, ExternalChangeWatcher watcher, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (matched, loadOrder) = ResolveAnyPhysicalCopy(mirror, req.Origin, decoded, logger);
        var modFolder = matched is null ? null : ModFolders.TrackedOf(loadOrder, new PluginKey(matched.Name, matched.Origin));
        if (modFolder is null)
            return Results.Problem($"{decoded} ({req.Origin}) is not a tracked plugin in the load order.", statusCode: 503);
        var pluginPath = matched!.Path;

        try
        {
            ExternalChangeAbsorber.Absorb(modFolder, decoded, pluginPath, loadOrder!);
            watcher.MarkAnswered(modFolder, decoded);
            watcher.Watch(modFolder, decoded, pluginPath);
            return Results.Ok(new ExternalChangeActionResponse(true, null));
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
    internal static IResult KeepExternalChange(string plugin, ExternalChangeActionRequest req, ILoadOrderMirror mirror, ExternalChangeWatcher watcher, SchemaReflector reflector, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var decoded = Uri.UnescapeDataString(plugin);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (matched, loadOrder) = ResolveAnyPhysicalCopy(mirror, req.Origin, decoded, logger);
        var modFolder = matched is null ? null : ModFolders.TrackedOf(loadOrder, new PluginKey(matched.Name, matched.Origin));
        if (modFolder is null)
            return Results.Problem($"{decoded} ({req.Origin}) is not a tracked plugin in the load order.", statusCode: 503);
        var pluginPath = matched!.Path;

        try
        {
            var result = ExternalChangeEditLander.Keep(
                modFolder, WriteEndpointMapping.PluginKeyOf(plugin, req.Origin), pluginPath, loadOrder!.GameRelease,
                mirror.Index!, reflector, logger);
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
    internal static IResult Rebase(RebaseRequest req, ILoadOrderMirror mirror, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (matched, _) = ResolveAnyPhysicalCopy(mirror, req.Origin, pluginName: null, logger);
        if (matched is null || Path.GetDirectoryName(matched.Path) is not { } modFolder)
            return Results.Problem($"No loaded plugin has origin '{req.Origin}'.", statusCode: 404);

        var result = SourceRepository.RebaseEditBranch(modFolder);
        return Results.Ok(ToRebaseResponse(result));
    }

    internal static IResult ContinueRebase(RebaseRequest req, ILoadOrderMirror mirror, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (matched, _) = ResolveAnyPhysicalCopy(mirror, req.Origin, pluginName: null, logger);
        if (matched is null || Path.GetDirectoryName(matched.Path) is not { } modFolder)
            return Results.Problem($"No loaded plugin has origin '{req.Origin}'.", statusCode: 404);

        var result = SourceRepository.ContinueRebase(modFolder);
        return Results.Ok(ToRebaseResponse(result));
    }

    private static RebaseResponse ToRebaseResponse(RebaseResult result) =>
        new(result.Outcome.ToString(), result.RefusalReason, result.ConflictedPaths);

    // The one resolver for the origin-scoped gestures (Rebase/ContinueRebase,
    // AbsorbExternalChange, KeepExternalChange) — deliberately not PluginOriginResolver.Resolve/
    // LoadOrderPlugin, which filters to load-order members only (InLoadOrder), by design, so a bare
    // filename stays a safe write target elsewhere on this write path. These four gestures must still
    // resolve a shadowed copy: a plugin loaded under this origin but shadowed by a higher-priority mod
    // of the same filename is exactly a mod whose external-change question, absorb, keep, or rebase
    // still needs answering, so the omission of that filter is named here rather than left to two
    // near-duplicate comments on two near-duplicate methods. pluginName narrows the match within the
    // origin (Absorb/Keep's own route carries one); null answers "whichever plugin this origin holds"
    // (Rebase/ContinueRebase's own RebaseRequest carries no plugin name). Each caller derives its own
    // mod folder from the matched entry afterward — Rebase/ContinueRebase via a bare
    // Path.GetDirectoryName (SourceRepository.RebaseEditBranch/ContinueRebase apply their own tracked
    // check), Absorb/Keep via ModFolders.TrackedOf (their own 503 gate) — because those are two
    // genuinely different questions ("where does this file live" vs "is this a tracked working tree"),
    // not a second copy of the matching this method already centralizes.
    private static (PluginMetadata? Plugin, ILoadOrder? LoadOrder) ResolveAnyPhysicalCopy(
        ILoadOrderMirror mirror, string origin, string? pluginName, ILogger logger)
    {
        var loadOrder = mirror.LoadOrder;
        var plugin = loadOrder?.Plugins.FirstOrDefault(p =>
            p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase)
            && (pluginName is null || p.Name.Equals(pluginName, StringComparison.OrdinalIgnoreCase)));
        if (plugin == null)
        {
            if (pluginName is null)
                logger.LogWarning("No loaded plugin has origin {Origin}", origin);
            else
                logger.LogWarning("No loaded plugin named {Plugin} with origin {Origin}", pluginName, origin);
            return (null, null);
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

// Outcome is RebaseOutcome's wire-safe string form ("Clean"/"Refused"/"Conflicted").
// ConflictedPaths is the extension's cue to open each path in VS Code's native merge editor.
public record RebaseResponse(string Outcome, string? RefusalReason, IReadOnlyList<string> ConflictedPaths);
