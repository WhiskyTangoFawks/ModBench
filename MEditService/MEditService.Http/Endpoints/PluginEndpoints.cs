using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Http.Endpoints;

internal static class PluginEndpoints
{
    private const string Tag = "Plugins";

    public static IEndpointRouteBuilder MapPluginEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/plugins", (IRecordQueryService svc) =>
            Results.Ok(svc.GetPlugins().Select(PluginResponse.Of).ToList()))
            .WithName("GetPlugins")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginResponse>>()
            .ProducesProblem(503);

        // Every mutable plugin in the load order, diagnosed off its original bytes — the
        // session-load complement of Track's refusal. With no load order applied the refusal is a
        // 503, never an unmapped 500.
        app.MapGet("/plugins/diagnoses", (MalformedPluginQueryService svc) =>
            Results.Ok(svc.GetLoadOrderDiagnoses()))
            .WithName("GetPluginDiagnoses")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginDiagnosisReport>>()
            .ProducesProblem(503);

        app.MapGet("/plugins/problems", (PluginProblemQueryService svc) =>
            svc.GetProblems() is { } problems
                ? Results.Ok(problems)
                : Results.Problem("mEdit's index is not ready, so what is wrong in the plugins' source is not known yet.", statusCode: 503))
            .WithName("GetPluginProblems")
            .WithTags(Tag)
            .WithDescription(
                "What is wrong in each tracked plugin's source, on the file that holds the " +
                "record: a reference to a record neither it nor an active plugin holds. Answers only once the index is ready.")
            .Produces<IReadOnlyList<PluginProblems>>()
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/dependants", (string plugin, string? origin, PluginDependantsQueryService svc) =>
        {
            if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
            return svc.GetDependants(WriteEndpointMapping.PluginAddressOf(plugin, origin)) is { } dependants
                ? Results.Ok(new PluginDependantsResponse(dependants.Plugins, dependants.Unreadable))
                : Results.Problem("mEdit has not finished indexing the plugins.", statusCode: 503);
        })
            .WithName("GetPluginDependants")
            .WithTags(Tag)
            .WithDescription(
                "The plugins that list the plugin's file name as a master, and the plugins whose masters " +
                "mEdit could not read. Answers only once the index is ready.")
            .Produces<PluginDependantsResponse>()
            .ProducesProblem(400)
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/record-types", (string plugin, string? origin, IRecordQueryService svc) =>
        {
            if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
            return Results.Ok(svc.GetPluginRecordTypes(WriteEndpointMapping.PluginAddressOf(plugin, origin)));
        })
            .WithName("GetPluginRecordTypes")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginRecordTypeCount>>()
            .ProducesProblem(400)
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/working-tree-states-beneath", (string plugin, string? origin, IRecordQueryService svc) =>
        {
            if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
            return Results.Ok(svc.GetWorkingTreeStatesBeneath(WriteEndpointMapping.PluginAddressOf(plugin, origin)));
        })
            .WithName("GetWorkingTreeStatesBeneath")
            .WithTags(Tag)
            .Produces<WorkingTreeStatesBeneath>()
            .ProducesProblem(400)
            .ProducesProblem(503);

        app.MapGet("/record-types/creatable", (IRecordQueryService svc) =>
            Results.Ok(svc.GetCreatableRecordTypes()))
            .WithName("GetCreatableRecordTypes")
            .WithTags(Tag)
            .Produces<IReadOnlyList<RecordTypeChoice>>()
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/records/{formKey}/child-record-types", (
            string plugin, string formKey, string? origin, IRecordQueryService svc) =>
            PluginRecordAnswer(plugin, formKey, origin, svc.GetChildRecordTypes))
            .WithName("GetChildRecordTypes")
            .WithTags(Tag)
            .WithDescription("The record types the plugin's copy of a container record can hold, in name order.")
            .Produces<IReadOnlyList<RecordTypeChoice>>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/records/{formKey}/rendered-document", (
            string plugin, string formKey, string? origin, IRecordQueryService svc) =>
            PluginRecordAnswer(plugin, formKey, origin, svc.GetRenderedDocument))
            .WithName("GetRenderedDocument")
            .WithTags(Tag)
            .WithDescription(
                "The plugin's copy of a record as its own document and the name of its file in plugin source. An untracked " +
                "plugin's is the text Track writes for it, under the name Track gives its file. A copy mEdit could not parse " +
                "is what could be stored. Two documents claiming the copy refuse, naming them.")
            .Produces<RenderedDocument>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(422)
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/records/{formKey}/file", (
            string plugin, string formKey, string? origin, IRecordQueryService svc) =>
            PluginRecordAnswer(plugin, formKey, origin, svc.GetRecordFile))
            .WithName("GetRecordFile")
            .WithTags(Tag)
            .WithDescription(
                "The absolute path of the file in plugin source holding the plugin's copy of a record: its own document, the " +
                "root header document for the Plugin Header record, or the document of the record carrying a child record. " +
                "Null for an untracked plugin's copy, which has no file. Two documents claiming the copy refuse, naming them.")
            .Produces<RecordFile>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(422)
            .ProducesProblem(503);

        app.MapGet("/plugins/creatable-extensions", (PluginExtensionsQueryService svc) =>
            Results.Ok(svc.GetCreatable()))
            .WithName("GetCreatablePluginExtensions")
            .WithTags(Tag)
            .WithDescription("The file extensions a new plugin may take in the held release.")
            .Produces<IReadOnlyList<string>>()
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

        app.MapPost("/plugins/rename-source", RenameSource)
            .WithName("RenameSource")
            .WithTags(Tag)
            .WithDescription(
                "Moves a tracked plugin's source, and what Modbench last wrote for it, to the new name as " +
                "working-tree changes: every FormKey of the plugin follows. The plugin file and its " +
                "plugins.txt lines stay as they are.")
            .Produces(204)
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
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
                "Mints a new record in the plugin's working tree: a new source file of its own, or, for a record created " +
                "in a container, an entry in the container's document. A git-native create, answering at Effective only " +
                "until committed and compiled.")
            .WithTags(Tag)
            .Produces<RecordCreateResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(500);

        return app;
    }

    internal static async Task<IResult> CreatePlugin(
        CreatePluginRequest req, CreatePluginHandler create, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (Malformed(req) is { } malformed) return malformed;

        var plugin = new PluginAddress(req.Name, req.Origin);
        var result = await create.CreatePlugin(plugin, req.Folder);
        if (result.Refusal is { } refusal)
        {
            WriteEndpointMapping.LogRefusal(logger, "Create plugin", refusal, result.Message, plugin);
            return WriteEndpointMapping.Refusal(refusal, result.Message);
        }

        return Results.Ok(new PluginCreatedResponse(plugin.Name, plugin.Origin));
    }

    // The refusals a malformed request earns, taken before the door so a name that could never be
    // a plugin file writes nothing.
    private static IResult? Malformed(CreatePluginRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.Problem("Plugin name is required.", statusCode: 400);
        return string.IsNullOrWhiteSpace(req.Folder) || string.IsNullOrWhiteSpace(req.Origin)
            ? Results.Problem("The folder and the origin are required.", statusCode: 400)
            : null;
    }

    internal static IResult RenameSource(
        RenameSourceRequest req, RenameSourceHandler rename, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (string.IsNullOrWhiteSpace(req.Name) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Plugin name and origin are required.", statusCode: 400);

        var plugin = new PluginAddress(req.Name, req.Origin);
        var result = rename.RenameSource(plugin, req.NewName ?? string.Empty);
        if (result.Refusal is not { } refusal) return Results.NoContent();

        WriteEndpointMapping.LogRefusal(logger, "Rename source", refusal, result.Message, plugin);
        return WriteEndpointMapping.Refusal(refusal, result.Message);
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

        return await WriteEndpointMapping.Answered(
            "Track", logger,
            trackHandler.TrackAsync(mods),
            WriteEndpointMapping.Refusal,
            landed => new TrackedModResponse(landed.Item, landed.Outcome.Tracked),
            refused => new ModTrackRefusal(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new TrackResponse(applied, refused));
    }

    // decompile-plugin: the selection (commands.md, A selection is one gesture).
    internal static Task<IResult> Decompile(
        DecompileRequest req, DecompilePluginHandler decompileHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        return OverPlugins(req.Plugins, plugins => WriteEndpointMapping.Answered(
            "Decompile", logger,
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
        return OverPlugins(req.Plugins, plugins => WriteEndpointMapping.Answered(
            "Compile", logger,
            compileHandler.CompileAsync(plugins),
            WriteEndpointMapping.Refusal,
            landed => new CompiledPlugin(landed.Item.Name, landed.Item.Origin, landed.Outcome),
            refused => new PluginCompileRefusal(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new CompileResponse(applied, refused)));
    }

    // The routes over a selection of plugins share their request's shape.
    private static async Task<IResult> OverPlugins(
        IReadOnlyList<PluginAddress>? requested,
        Func<IReadOnlyList<PluginAddress>, Task<IResult>> answer)
    {
        var plugins = requested ?? [];
        if (plugins.Count == 0)
            return Results.Problem("At least one plugin is required.", statusCode: 400);
        if (plugins.Any(p => string.IsNullOrWhiteSpace(p.Name) || string.IsNullOrWhiteSpace(p.Origin)))
            return Results.Problem("Every plugin needs a name and an origin.", statusCode: 400);

        return await answer(plugins);
    }

    // logReceived is null on purpose: no PluginEndpoints handler logs on entry,
    // UseSerilogRequestLogging's per-request summary covers it.
    internal static IResult CreateRecord(
        string plugin, RecordCreateRequest req, CreateRecordHandler edits, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        return WriteEndpointMapping.Execute(
            "Create record", logger,
            logReceived: null,
            validate: () =>
            {
                if (string.IsNullOrWhiteSpace(req.Origin))
                    return Results.Problem("Origin is required.", statusCode: 400);
                if (string.IsNullOrWhiteSpace(req.RecordType))
                    return Results.Problem("A record type is required.", statusCode: 400);
                return null;
            },
            execute: () => edits.CreateRecord(WriteEndpointMapping.PluginAddressOf(plugin, req.Origin), req.RecordType, req.Container, req.Position),
            onApplied: result => Results.Ok(new RecordCreateResponse(true, WriteEndpointMapping.RequireNewFormKey(result), req.RecordType)));
    }

    private static IResult PluginRecordAnswer<T>(
        string plugin, string formKey, string? origin, Func<PluginAddress, string, T?> answer) where T : class
    {
        if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
        try
        {
            return answer(WriteEndpointMapping.PluginAddressOf(plugin, origin), Uri.UnescapeDataString(formKey)) is { } found
                ? Results.Ok(found)
                : Results.Problem("The plugin holds no such record.", statusCode: 404);
        }
        catch (AmbiguousSourceUnitException ex)
        {
            return Results.Problem(ex.Message, statusCode: 422);
        }
    }
}

/// <summary>The origin and the file name are the plugin (ADR-0012); the folder is where
/// the instance holds that origin's files.</summary>
internal sealed record CreatePluginRequest(string Origin, string Name, string Folder);

/// <summary>The plugins that list the plugin as a master, and those whose masters could not be read.</summary>
internal sealed record PluginDependantsResponse(IReadOnlyList<PluginAddress> Dependants, IReadOnlyList<PluginAddress> Unreadable);

/// <summary>The plugin the create gesture wrote. Not a plugin row: the Index has not seen
/// it, and nothing registers it.</summary>
internal sealed record PluginCreatedResponse(string Name, string Origin);

/// <summary>The plugin by its origin and file name (ADR-0012), and the file name its source takes.</summary>
internal sealed record RenameSourceRequest(string Origin, string Name, string NewName);

/// <summary>The mods by name; the load order says each one's plugins and folder.</summary>
internal sealed record TrackRequest(IReadOnlyList<string> Mods);

/// <summary>A mod of the selection that tracked: the plugins whose source landed.</summary>
internal sealed record TrackedModResponse(string Mod, IReadOnlyList<PluginAddress> Tracked);

/// <summary>A mod of the selection that wrote nothing: the typed refusal, and the message naming the
/// way out.</summary>
internal sealed record ModTrackRefusal(string Item, TrackRefusal Refusal, string Message);

/// <summary>Applied or refusal, per mod (ADR-0019), never the status of the call.</summary>
internal sealed record TrackResponse(IReadOnlyList<TrackedModResponse> Applied, IReadOnlyList<ModTrackRefusal> Refused);

internal sealed record DecompileRequest(IReadOnlyList<PluginAddress> Plugins);

/// <summary>Applied or refusal, per plugin (ADR-0019), never the status of the call.</summary>
internal sealed record DecompileResponse(IReadOnlyList<PluginAddress> Applied, IReadOnlyList<PluginDecompileRefusal> Refused);

/// <summary>A plugin of the selection that wrote nothing, with the typed refusal and the message naming
/// the way out.</summary>
internal sealed record PluginDecompileRefusal(PluginAddress Item, DecompileRefusal Refusal, string Message);

internal sealed record CompileRequest(IReadOnlyList<PluginAddress> Plugins);

/// <summary>Applied or refusal, per plugin (ADR-0019), never the status of the call.</summary>
internal sealed record CompileResponse(IReadOnlyList<CompiledPlugin> Applied, IReadOnlyList<PluginCompileRefusal> Refused);

/// <summary>A plugin of the selection whose binary was written, with its diagnostics (ADR-0007).</summary>
internal sealed record CompiledPlugin(string Name, string Origin, IReadOnlyList<CompileDiagnostic> Diagnostics);

/// <summary>A plugin of the selection that wrote nothing, with the typed refusal and the message naming
/// the way out.</summary>
internal sealed record PluginCompileRefusal(PluginAddress Item, CompileRefusal Refusal, string Message);
