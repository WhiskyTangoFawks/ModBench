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
        // complement of Track's refusal. RequireReads' throw becomes a 503, never an unmapped 500.
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
            .Produces<PluginCreatedResponse>()
            .ProducesProblem(400)
            // 404 and 422 are Track's own refusal map, which this route answers with rather than
            // repeating inline: the destination is Tracked inside this gesture.
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
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(500)
            .ProducesProblem(503);

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

        // Absorb, origin-scoped: the mod is the unit of a baseline, not one plugin
        // in it. Rebases the edit branch onto the new baseline it commits.
        app.MapPost("/plugins/external-change/absorb", AbsorbExternalChange)
            .WithName("AbsorbExternalChange")
            .WithTags(Tag)
            .Produces<ExternalChangeActionResponse>()
            .ProducesProblem(400)
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

        // The manual rebase (Modbench: Rebase onto Updated Baseline), for re-running after Absorb's
        // own rebase refused or conflicted. Origin-scoped — the repo, not any one plugin, is the
        // unit of baselines and rebase.
        app.MapPost("/plugins/rebase", Rebase)
            .WithName("RebaseEditBranch")
            .WithTags(Tag)
            .Produces<RebaseResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404);

        app.MapPost("/plugins/rebase/continue", ContinueRebase)
            .WithName("ContinueRebaseEditBranch")
            .WithTags(Tag)
            .Produces<RebaseResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404);

        return app;
    }

    // ADR-0041: an untracked destination is Tracked in the same gesture, silently and always under
    // Edits — the one-keystroke "Enter accepts overwrite/" framing rules out a second prompt.
    // Never touches plugins.txt; that append is the caller's.
    internal static async Task<IResult> CreatePlugin(
        CreatePluginRequest req, IndexProjector index, CreatePluginHandler create, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.Problem("Plugin name is required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(req.Path) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Destination path and origin are required.", statusCode: 400);

        try
        {
            var result = await create.CreatePlugin(HeldCopies(index), req.Name, req.Path, req.Origin);
            if (result.Track is { Applied: false } refused)
            {
                // Loud, not silent: the plugin file and load order entry already landed, but
                // plugins.txt is never appended without a 2xx, so no load order can name this
                // half-created plugin. The orphaned entry is accepted residue.
                logger.LogError(
                    "Refused to track {Origin} while creating {Name}: {Refusal}",
                    req.Origin, req.Name, refused.Refusal);
                return WriteEndpointMapping.Refusal(refused);
            }

            // ADR-0046 invariants 1 and 4: the write is done. The Index has never held this copy, so
            // it learns of it from the next snapshot, as it does for any newly installed plugin.
            var copy = result.Copy;
            return Results.Ok(new PluginCreatedResponse(copy.Name, copy.Path, copy.Origin, copy.Slot));
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
            // RequireReads for the refusal only: which copies this origin registers is the load
            // order's answer, read from the shared kernel rather than from the Index.
            index.RequireReads();
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

    // Shared with ExternalChangeApplier's own overflow path, which starts from a bare
    // (modFolder, pluginName) identity.
    internal static string OriginOfExternalChange(LoadOrder loadOrder, string modFolder, string pluginName) =>
        loadOrder.Copies.FirstOrDefault(copy =>
            copy.Name.Equals(pluginName, StringComparison.OrdinalIgnoreCase)
            && ModFolders.Of(copy.Origin, copy.Path) == modFolder)?.Origin ?? "";

    // The mod-level counterpart: a change's own Plugins list can be empty (a tracked-file-only
    // change), so origin resolves off the mod folder alone.
    internal static string OriginOfExternalChange(LoadOrder loadOrder, string modFolder) =>
        loadOrder.Copies.FirstOrDefault(copy => ModFolders.Of(copy.Origin, copy.Path) == modFolder)?.Origin ?? "";

    // Absorb, origin-scoped: every plugin the mod holds is re-parsed together, so
    // the baseline it commits covers the whole mod in one go.
    internal static IResult AbsorbExternalChange(
        ExternalChangeActionRequest req, IndexProjector index, AbsorbExternalChangeHandler handler,
        ModFolderWatcher watcher, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (plugins, loadOrder, modFolder) = ResolveTrackedMod(index, req.Origin, logger);
        if (modFolder is null)
            return Results.Problem($"'{req.Origin}' is not a tracked mod in the load order.", statusCode: 503);

        try
        {
            var result = handler.Absorb(modFolder, plugins, loadOrder);
            if (result.Applied)
                foreach (var plugin in plugins) watcher.Watch(modFolder, plugin.Name, plugin.Path);
            var rebase = result.Rebase is { } r ? new RebaseResponse(r.Outcome, r.RefusalReason, r.ConflictedPaths) : null;
            return Results.Ok(new ExternalChangeActionResponse(result.Applied, result.RefusalReason, rebase));
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
        ExternalChangeActionRequest req, IndexProjector index, KeepExternalChangeHandler handler,
        ModFolderWatcher watcher, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        var (plugins, loadOrder, modFolder) = ResolveTrackedMod(index, req.Origin, logger);
        if (modFolder is null)
            return Results.Problem($"'{req.Origin}' is not a tracked mod in the load order.", statusCode: 503);

        try
        {
            var result = handler.Keep(modFolder, plugins, loadOrder.GameRelease);
            if (result.Applied)
                foreach (var plugin in plugins) watcher.Watch(modFolder, plugin.Name, plugin.Path);
            return Results.Ok(new ExternalChangeActionResponse(result.Applied, result.RefusalReason));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not keep external change for {Origin}", req.Origin);
            return WriteEndpointMapping.WriteFailure($"Could not keep external change for {req.Origin}: {ex.Message}");
        }
    }

    // Every plugin the origin's mod folder holds; null ModFolder means untracked or unknown, the
    // caller's single refusal path for both.
    private static (IReadOnlyList<RegisteredCopy> Plugins, LoadOrder LoadOrder, string? ModFolder) ResolveTrackedMod(
        IndexProjector index, string origin, ILogger logger)
    {
        var loadOrder = index.LoadOrder is { } held ? LoadOrder.From(held) : LoadOrder.Empty;
        var plugins = ModFolders.PluginsOfOrigin(loadOrder, origin);
        if (plugins.Count == 0)
        {
            logger.LogWarning("No loaded plugin has origin {Origin}", origin);
            return ([], loadOrder, null);
        }

        var modFolder = ModFolders.Of(plugins[0].Origin, plugins[0].Path);
        return modFolder is null || !SourceRepository.IsTracked(modFolder)
            ? (plugins, loadOrder, null)
            : (plugins, loadOrder, modFolder);
    }

    // The manual rebase, origin-scoped — the repo is the unit of baselines and rebase, not
    // any one plugin inside it.
    internal static IResult Rebase(RebaseRequest req, RebaseEditBranchHandler handler, ILoggerFactory loggerFactory)
    {
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        return Rebased(
            handler.RebaseEditBranch(req.Origin), req.Origin, loggerFactory.CreateLogger(nameof(PluginEndpoints)));
    }

    internal static IResult ContinueRebase(
        RebaseRequest req, ContinueRebaseEditBranchHandler handler, ILoggerFactory loggerFactory)
    {
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);

        return Rebased(
            handler.ContinueRebase(req.Origin), req.Origin, loggerFactory.CreateLogger(nameof(PluginEndpoints)));
    }

    // An origin no registered copy carries names no repository, which is a 404 rather than one of
    // the three outcomes a rebase reports.
    private static IResult Rebased(RebaseResult? result, string origin, ILogger logger)
    {
        if (result is null)
        {
            logger.LogWarning("No loaded plugin has origin {Origin}", origin);
            return Results.Problem($"No loaded plugin has origin '{origin}'.", statusCode: 404);
        }
        return Results.Ok(new RebaseResponse(result.Outcome, result.RefusalReason, result.ConflictedPaths));
    }

}

// Path/Origin are the destination Mod Management's QuickPick resolved (an existing mod, a
// freshly installed mod folder, or overwrite/) — the caller resolves which physical folder, the
// backend acts on it.
public record CreatePluginRequest(string Name, string Path, string Origin);

// What the create gesture wrote and registered, not a plugin row: masters, flags and record count
// are the Index's to state, and it has not seen this copy yet. Slot is 0 off a bare load order.
public record PluginCreatedResponse(string Name, string Path, string Origin, int? Slot);

// Preset is the wire-safe string form of SourcePreset ("Edits"/"Everything") — no Plugin/Path
// needed: Origin alone is enough for TrackService to resolve every plugin sharing that mod folder.
public record TrackRequest(string Origin, string Preset);

public record TrackResponse(string Origin);

// Ref null means CompileSource.WorkingTree (the normal Save & Compile); a name (e.g. "main")
// means CompileSource.AtRef — no confirmation flag, that UX lives entirely on the extension side.
public record CompileRequest(string Origin, string? Ref);

// Absorb / Keep are origin-scoped — the mod, not one plugin in it, is
// the unit of a baseline, matching RebaseRequest's own shape.
public record ExternalChangeActionRequest(string Origin);

// Rebase is set only by Absorb, which rebases the edit branch onto the new baseline it just
// committed; Keep never rebases, so its response always carries a null Rebase.
public record ExternalChangeActionResponse(bool Succeeded, string? RefusalReason, RebaseResponse? Rebase = null);

// Origin-scoped — the repo is the unit of baselines and rebase.
public record RebaseRequest(string Origin);

// Outcome is the RebaseOutcome enum rather than a string so the OpenAPI schema, and the generated
// client, get the closed union. ConflictedPaths is the extension's cue to open each path in
// VS Code's merge editor.
public record RebaseResponse(RebaseOutcome Outcome, string? RefusalReason, IReadOnlyList<string> ConflictedPaths);
