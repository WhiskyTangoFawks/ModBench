using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.Queries;

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
            if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
            var decoded = Uri.UnescapeDataString(plugin);
            return Results.Ok(svc.GetPluginRecordTypes(decoded, origin));
        })
            .WithName("GetPluginRecordTypes")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginRecordTypeCount>>()
            .ProducesProblem(400);

        app.MapGet("/record-types/creatable", (IRecordQueryService svc) =>
        {
            try
            {
                return Results.Ok(svc.GetCreatableRecordTypes());
            }
            catch (NoLoadOrderException ex)
            {
                return WriteEndpointMapping.NoLoadOrder(ex);
            }
        })
            .WithName("GetCreatableRecordTypes")
            .WithTags(Tag)
            .Produces<IReadOnlyList<CreatableRecordType>>()
            .ProducesProblem(503);

        app.MapGet("/plugins/light-plugins-supported", (IRecordQueryService svc) =>
        {
            try
            {
                return Results.Ok(svc.GetLightPluginsSupported());
            }
            catch (NoLoadOrderException ex)
            {
                return WriteEndpointMapping.NoLoadOrder(ex);
            }
        })
            .WithName("GetLightPluginsSupported")
            .WithTags(Tag)
            .Produces<bool>()
            .ProducesProblem(503);

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

        app.MapPost("/plugins/decompile", Decompile)
            .WithName("DecompilePlugin")
            .WithTags(Tag)
            .Produces<DecompileResponse>()
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

    // Track (ADR-0007) over a selection of mods (commands.md, A selection is one gesture); the
    // load order says each mod's plugins and folder.
    internal static async Task<IResult> Track(
        TrackRequest req, TrackHandler trackHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var mods = req.Mods ?? [];
        if (mods.Count == 0)
            return Results.Problem("At least one mod is required.", statusCode: 400);
        if (mods.Any(string.IsNullOrWhiteSpace))
            return Results.Problem("Every mod needs a name.", statusCode: 400);

        try
        {
            var result = await trackHandler.TrackAsync(mods);
            if (result.SelectionRefusal is { } selectionRefusal)
            {
                logger.LogWarning("Refused to track {Count} mod(s): {Refusal} — {Message}",
                    mods.Count, selectionRefusal.Refusal, selectionRefusal.Message);
                return WriteEndpointMapping.Refusal(selectionRefusal);
            }

            foreach (var refusedMod in result.RefusedMods)
                logger.LogWarning("Refused to track {Mod}: {Refusal} — {Message}", refusedMod.Mod, refusedMod.Refusal, refusedMod.Message);
            foreach (var refused in result.Refused)
            {
                logger.LogWarning("Refused to track {Plugin} ({Origin}): {Refusal} — {Message}",
                    refused.Plugin.Name, refused.Plugin.Origin, refused.Refusal, refused.Message);
            }
            return Results.Ok(new TrackResponse(
                result.Landed,
                [.. result.Refused.Select(r => new PluginAddressRefusal(r.Plugin, r.Refusal, r.Message))],
                result.RefusedMods));
        }
        catch (NoLoadOrderException ex)
        {
            logger.LogError(ex, "No loadOrder when tracking {Count} mod(s)", mods.Count);
            return WriteEndpointMapping.NoLoadOrder(ex);
        }
    }

    // decompile-plugin: the selection (commands.md, A selection is one gesture).
    internal static Task<IResult> Decompile(
        DecompileRequest req, DecompilePluginHandler decompileHandler, ILoggerFactory loggerFactory)
    {
        return OverPlugins(req.Plugins, "decompiling", loggerFactory, plugins => WriteEndpointMapping.Answered(
            decompileHandler.DecompileAsync(plugins),
            WriteEndpointMapping.Refusal,
            landed => landed.Item,
            refused => new PluginDecompileRefusal(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new DecompileResponse(applied, refused)));
    }

    // compile-plugin: the selection (commands.md, A selection is one gesture).
    internal static Task<IResult> Compile(
        CompileRequest req, CompilePluginHandler compileHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        return OverPlugins(req.Plugins, "compiling", loggerFactory, plugins => WriteEndpointMapping.Answered(
            compileHandler.CompileAsync(plugins),
            WriteEndpointMapping.Refusal,
            landed => new CompiledPlugin(landed.Item.Name, landed.Item.Origin, landed.Outcome),
            refused =>
            {
                logger.LogWarning("Refused to compile {Plugin} ({Origin}): {Refusal} — {Message}",
                    refused.Item.Name, refused.Item.Origin, refused.Refusal, refused.Message);
                return new PluginCompileRefusal(refused.Item, refused.Refusal, refused.Message);
            },
            (applied, refused) => new CompileResponse(applied, refused)));
    }

    // The routes over a selection of plugins share their request's shape and one answer that is no
    // plugin's: the load order went away underneath the request, a "not right now".
    private static async Task<IResult> OverPlugins(
        IReadOnlyList<PluginAddress>? requested, string gesture, ILoggerFactory loggerFactory,
        Func<IReadOnlyList<PluginAddress>, Task<IResult>> answer)
    {
        var plugins = requested ?? [];
        if (plugins.Count == 0)
            return Results.Problem("At least one plugin is required.", statusCode: 400);
        if (plugins.Any(p => string.IsNullOrWhiteSpace(p.Name) || string.IsNullOrWhiteSpace(p.Origin)))
            return Results.Problem("Every plugin needs a name and an origin.", statusCode: 400);

        try
        {
            return await answer(plugins);
        }
        catch (NoLoadOrderException ex)
        {
            loggerFactory.CreateLogger(nameof(PluginEndpoints))
                .LogError(ex, "No loadOrder while {Gesture} {Count} plugin(s)", gesture, plugins.Count);
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
}

/// <summary>The origin and the file name are the plugin (ADR-0012); the folder is where
/// the instance holds that origin's files.</summary>
public record CreatePluginRequest(string Origin, string Name, string Folder);

/// <summary>The plugin the create gesture wrote and where. Not a plugin row: the Index has not seen
/// it, and nothing registers it.</summary>
public record PluginCreatedResponse(string Name, string Origin, string Path);

/// <summary>A plugin of the selection that wrote nothing of its own: the typed refusal, and the
/// message naming the way out.</summary>
public record PluginAddressRefusal(PluginAddress Plugin, TrackRefusal Refusal, string Message);

/// <summary>The mods by name; the load order says each one's plugins and folder.</summary>
public record TrackRequest(IReadOnlyList<string> Mods);

/// <summary>Applied or refusal, per plugin and per mod that provides no plugin (ADR-0019), never the status of the call.</summary>
public record TrackResponse(
    IReadOnlyList<PluginAddress> Applied, IReadOnlyList<PluginAddressRefusal> Refused, IReadOnlyList<TrackRefusedMod> RefusedMods);

public record DecompileRequest(IReadOnlyList<PluginAddress> Plugins);

/// <summary>Applied or refusal, per plugin (ADR-0019), never the status of the call.</summary>
public record DecompileResponse(IReadOnlyList<PluginAddress> Applied, IReadOnlyList<PluginDecompileRefusal> Refused);

/// <summary>A plugin of the selection that wrote nothing, with the typed refusal and the message naming
/// the way out.</summary>
public record PluginDecompileRefusal(PluginAddress Item, DecompileRefusal Refusal, string Message);

public record CompileRequest(IReadOnlyList<PluginAddress> Plugins);

/// <summary>Applied or refusal, per plugin (ADR-0019), never the status of the call.</summary>
public record CompileResponse(IReadOnlyList<CompiledPlugin> Applied, IReadOnlyList<PluginCompileRefusal> Refused);

/// <summary>A plugin of the selection whose binary was written, with its diagnostics (ADR-0007).</summary>
public record CompiledPlugin(string Name, string Origin, IReadOnlyList<CompileDiagnostic> Diagnostics);

/// <summary>A plugin of the selection that wrote nothing, with the typed refusal and the message naming
/// the way out.</summary>
public record PluginCompileRefusal(PluginAddress Item, CompileRefusal Refusal, string Message);
