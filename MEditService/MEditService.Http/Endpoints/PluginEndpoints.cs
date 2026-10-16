using MEditService.Codec.Schema;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.Http.Endpoints;

internal static class PluginEndpoints
{
    private const string Tag = "Plugins";

    public static IEndpointRouteBuilder MapPluginEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/plugins", (IQueries svc) =>
            EndpointMapping.Answered(svc.GetPlugins(), plugins => Results.Ok(plugins.Select(PluginResponse.Of).ToList())))
            .WithName("GetPlugins")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginResponse>>()
            .ProducesProblem(503);

        // Every mutable plugin in the load order, diagnosed off its original bytes — the
        // session-load complement of init's refusal. With no load order applied the refusal is a
        // 503, never an unmapped 500.
        app.MapGet("/plugins/diagnoses", (IQueries svc) =>
            EndpointMapping.Ok(svc.GetLoadOrderDiagnoses()))
            .WithName("GetPluginDiagnoses")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginDiagnosisReport>>()
            .ProducesProblem(503);

        app.MapGet("/plugins/problems", (IQueries svc) =>
            EndpointMapping.Ok(svc.GetProblems()))
            .WithName("GetPluginProblems")
            .WithTags(Tag)
            .WithDescription(
                "What is wrong in each compiled plugin's source, on the file that holds the " +
                "record: a reference to a record neither it nor an active plugin holds. Answers only once the index is ready.")
            .Produces<IReadOnlyList<PluginProblems>>()
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/dependants", (string plugin, string? origin, IQueries svc) =>
        {
            if (!EndpointMapping.PluginAt(plugin, origin, out var address, out var refused)) return refused;
            return EndpointMapping.Answered(
                svc.GetDependants(address),
                dependants => Results.Ok(new PluginDependantsResponse(dependants.Plugins, dependants.Unreadable)));
        })
            .WithName("GetPluginDependants")
            .WithTags(Tag)
            .WithDescription(
                "The plugins that list the plugin's file name as a master, and the plugins whose masters " +
                "mEdit could not read. Answers only once the index is ready.")
            .Produces<PluginDependantsResponse>()
            .ProducesProblem(400)
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/record-types", (string plugin, string? origin, IQueries svc) =>
        {
            if (!EndpointMapping.PluginAt(plugin, origin, out var address, out var refused)) return refused;
            return EndpointMapping.Ok(svc.GetPluginRecordTypes(address));
        })
            .WithName("GetPluginRecordTypes")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginRecordTypeCount>>()
            .ProducesProblem(400)
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/working-tree-states-beneath", (string plugin, string? origin, IQueries svc) =>
        {
            if (!EndpointMapping.PluginAt(plugin, origin, out var address, out var refused)) return refused;
            return EndpointMapping.Ok(svc.GetWorkingTreeStatesBeneath(address));
        })
            .WithName("GetWorkingTreeStatesBeneath")
            .WithTags(Tag)
            .Produces<WorkingTreeStatesBeneath>()
            .ProducesProblem(400)
            .ProducesProblem(503);

        app.MapGet("/record-types/creatable", (IQueries svc) =>
            EndpointMapping.Ok(svc.GetCreatableRecordTypes()))
            .WithName("GetCreatableRecordTypes")
            .WithTags(Tag)
            .Produces<IReadOnlyList<RecordTypeChoice>>()
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/records/{formKey}/child-record-types", (
            string plugin, string formKey, string? origin, IQueries svc) =>
            PluginRecordAnswer(plugin, formKey, origin, svc.GetChildRecordTypes))
            .WithName("GetChildRecordTypes")
            .WithTags(Tag)
            .WithDescription("The record types the plugin's copy of a container record can hold, in name order.")
            .Produces<IReadOnlyList<RecordTypeChoice>>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/records/{formKey}/rendered-document", (
            string plugin, string formKey, string? origin, IQueries svc) =>
            PluginRecordAnswer(plugin, formKey, origin, svc.GetRenderedDocument))
            .WithName("GetRenderedDocument")
            .WithTags(Tag)
            .WithDescription(
                "The plugin's copy of a record as its own document and the name of its file in plugin source. A non-compiled " +
                "plugin's is the text init writes for it, under the name init gives its file. A copy mEdit could not parse " +
                "is what could be stored. Two documents claiming the copy refuse, naming them.")
            .Produces<RenderedDocument>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(422)
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/records/{formKey}/document", (
            string plugin, string formKey, string? origin, IQueries svc) =>
            PluginRecordAnswer(plugin, formKey, origin, svc.GetCopyDocument))
            .WithName("GetCopyDocument")
            .WithTags(Tag)
            .WithDescription(
                "Where the plugin's copy of a record is a document: its own file in plugin source, the file of the record carrying " +
                "it (a child record), or, for a non-compiled plugin's copy, the name of its rendered document. " +
                "Two documents claiming the copy refuse, naming them.")
            .Produces<CopyDocument>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(422)
            .ProducesProblem(503);

        app.MapGet("/plugins/creatable-extensions", (LoadOrderHolder loadOrder) =>
            loadOrder.Held is { Snapshot: var held }
                ? Results.Ok(CreatablePluginExtensions.Of(held.GameRelease))
                : EndpointMapping.NoLoadOrder())
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
                "nothing else: no init, no load order change and no plugins.txt line.")
            .Produces<PluginCreatedResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(503);

        app.MapPost("/plugins/create-in-mod", CreatePluginInMod)
            .WithName("CreatePluginInMod")
            .WithTags(Tag)
            .WithDescription(
                "Writes an empty plugin into the folder, and the source folder, of an enabled mod or " +
                "Overwrite the held load order names as a place, by its origin. Refuses any other origin.")
            .Produces<PluginCreatedResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(503);

        app.MapPost("/plugins/decompile", Decompile)
            .WithName("DecompilePlugin")
            .WithTags(Tag)
            .Produces<DecompileResponse>()
            .ProducesProblem(400)
            // git missing refuses the whole selection; every other refusal is an item of the answer.
            .ProducesProblem(500)
            .ProducesProblem(503);

        app.MapPost("/plugins/rename-source-changes", RenameSourceChanges)
            .WithName("RenameSourceChanges")
            .WithSummary("The changes renaming a compiled plugin's source makes, writing nothing.")
            .WithDescription(
                "Over the unsaved documents mEdit holds, the files and folders renaming the plugin's source " +
                "moves and the text each document it changes holds afterwards: every FormKey of the plugin follows. " +
                "Moves come first, then deletions, then documents, and every path is absolute. The plugin file, its " +
                "plugins.txt lines and what Modbench last wrote stay as they are.")
            .Produces<RenameSourceChangesResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(500)
            .ProducesProblem(503);

        app.MapPost("/plugins/move-last-written", MoveLastWritten)
            .WithName("MoveLastWritten")
            .WithDescription(
                "Moves what Modbench last wrote for a plugin to the plugin's new name, once the source rename is applied and saved.")
            .WithTags(Tag)
            .Produces(204)
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
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

        // The plugin hosts the new group, so it owns the route the way Compile does; the FormKey doesn't
        // exist yet, which is exactly why this isn't under /records/{formKey}.
        app.MapPost("/plugins/{plugin}/create-record-changes", CreateRecordChanges)
            .WithName("CreateRecordChanges")
            .WithSummary("The changes creating a record makes to plugin source, writing nothing.")
            .WithDescription(
                "Over the unsaved documents mEdit holds, the files and folders creating a new record deletes and " +
                "moves and the text each document it changes or creates holds afterwards: a new source file of its own, or, " +
                "for a record created in a container, an entry in the container's document. Moves come first, then " +
                "deletions, then documents, and every path is absolute. The answer names the new FormKey. " +
                "Git-native: the record answers at Effective only until committed and compiled.")
            .WithTags(Tag)
            .Produces<RecordCreateChangesResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(500);

        app.MapPost("/plugins/{plugin}/create-record", CreateRecord)
            .WithName("CreateRecord")
            .WithSummary("Writes a new record to plugin source: a script's create.")
            .WithDescription(
                "Writes to the working tree what the same creation's changes answer, an unsaved document read in place " +
                "of its file. Answers the new FormKey. A creation that would write a file held unsaved is refused " +
                "naming it, and nothing is written.")
            .WithTags(Tag)
            .Produces<RecordWrittenResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(500);

        return app;
    }

    internal static Task<IResult> CreateRecord(
        string plugin, RecordCreateChangesRequest req, CreateRecordHandler creates, ILoggerFactory loggerFactory)
    {
        if (!EndpointMapping.PluginAt(plugin, req.Origin, out var address, out var refused)) return Task.FromResult(refused);
        return EndpointMapping.ExecuteWriting(
            "CreateRecord", loggerFactory.CreateLogger(nameof(PluginEndpoints)),
            logReceived: null,
            validate: () => string.IsNullOrWhiteSpace(req.RecordType)
                ? Results.Problem("A record type is required.", statusCode: 400)
                : null,
            execute: () => Task.FromResult(creates.Create(address, req.RecordType, req.Container, req.Position)),
            onApplied: result => Results.Ok(new RecordWrittenResponse(EndpointMapping.RequireNewFormKey(result))));
    }

    internal static async Task<IResult> CreatePlugin(
        CreatePluginRequest req, CreatePluginHandler create, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (Malformed(req) is { } malformed) return malformed;

        var plugin = new PluginAddress(req.Name, req.Origin);
        var result = await create.CreatePlugin(plugin, req.Folder, req.SourceFolder);
        return Created(logger, "Create plugin", plugin, result);
    }

    internal static async Task<IResult> CreatePluginInMod(
        CreatePluginInModRequest req, CreatePluginInModHandler create, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (RenamedPlugin(req.Name, req.Origin) is not { } plugin) return Results.Problem("Plugin name and origin are required.", statusCode: 400);

        var result = await create.CreatePluginIn(plugin.Origin, plugin.Name);
        return Created(logger, "Create plugin in mod", plugin, result);
    }

    private static IResult Created(ILogger logger, string gesture, PluginAddress plugin, PluginCreateResult result)
    {
        if (result.Refusal is not { } refusal) return Results.Ok(new PluginCreatedResponse((result.Created ?? plugin).Name, (result.Created ?? plugin).Origin));

        EndpointMapping.LogRefusal(logger, gesture, refusal, result.Message, plugin);
        return EndpointMapping.Refusal(refusal, result.Message);
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

    internal static IResult RenameSourceChanges(
        RenameSourceChangesRequest req, RenameSourceChangesHandler rename, ILoggerFactory loggerFactory)
    {
        if (RenamedPlugin(req.Name, req.Origin) is not { } plugin) return Results.Problem("Plugin name and origin are required.", statusCode: 400);

        var result = rename.RenameSource(plugin, req.NewName ?? string.Empty);
        return result.Match(
            (changes, treeName) => Results.Ok(RenameSourceChangesResponse.Of(treeName, changes)),
            (refusal, message) => Refused(loggerFactory, "Rename source", refusal, message, plugin));
    }

    internal static IResult MoveLastWritten(
        MoveLastWrittenRequest req, MoveLastWrittenHandler move, ILoggerFactory loggerFactory)
    {
        if (RenamedPlugin(req.Name, req.Origin) is not { } plugin || string.IsNullOrWhiteSpace(req.TreeName))
            return Results.Problem("Plugin name, origin and tree name are required.", statusCode: 400);

        var result = move.MoveLastWritten(plugin, req.TreeName, req.NewName ?? string.Empty);
        return result.Refusal is { } refusal
            ? Refused(loggerFactory, "Move last written", refusal, result.Message, plugin)
            : Results.NoContent();
    }

    private static PluginAddress? RenamedPlugin(string? name, string? origin) =>
        string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(origin) ? null : new PluginAddress(name, origin);

    private static IResult Refused(ILoggerFactory loggerFactory, string gesture, RenameSourceRefusal refusal, string? message, PluginAddress plugin)
    {
        EndpointMapping.LogRefusal(loggerFactory.CreateLogger(nameof(PluginEndpoints)), gesture, refusal, message, plugin);
        return EndpointMapping.Refusal(refusal, message);
    }

    // decompile-plugin: the selection (commands.md, A selection is one gesture).
    internal static Task<IResult> Decompile(
        DecompileRequest req, DecompilePluginHandler decompileHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        return OverPlugins(req.Plugins, plugins => EndpointMapping.Answered(
            "Decompile", logger,
            decompileHandler.DecompileAsync(plugins, req.Force),
            EndpointMapping.Refusal,
            landed => landed.Item,
            refused => new PluginDecompileRefusal(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new DecompileResponse(applied, refused)));
    }

    // compile-plugin: the selection (commands.md, A selection is one gesture).
    internal static Task<IResult> Compile(
        CompileRequest req, CompilePluginHandler compileHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        return OverPlugins(req.Plugins, plugins => EndpointMapping.Answered(
            "Compile", logger,
            compileHandler.CompileAsync(plugins),
            EndpointMapping.Refusal,
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
    internal static IResult CreateRecordChanges(
        string plugin, RecordCreateChangesRequest req, CreateRecordChangesHandler edits, ILoggerFactory loggerFactory)
    {
        if (!EndpointMapping.PluginAt(plugin, req.Origin, out var address, out var refused)) return refused;
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        return EndpointMapping.Execute(
            "Create record", logger,
            logReceived: null,
            validate: () => string.IsNullOrWhiteSpace(req.RecordType)
                ? Results.Problem("A record type is required.", statusCode: 400)
                : null,
            execute: () => edits.CreateRecord(
                address, req.RecordType, req.Container, req.Position),
            outcome: answer => answer.Outcome,
            onApplied: answer => Results.Ok(RecordCreateChangesResponse.Of(EndpointMapping.RequireNewFormKey(answer.Outcome), answer)));
    }

    // A source tree that cannot say where the copy is answers why.
    private static IResult PluginRecordAnswer<T>(
        string plugin, string formKey, string? origin, Func<PluginAddress, string, Answer<T?, IndexRefused>> answer) where T : class
    {
        if (!EndpointMapping.PluginAt(plugin, origin, out var address, out var refused)) return refused;
        return EndpointMapping.Answered(
            answer(address, Uri.UnescapeDataString(formKey)),
            found => found is not null ? Results.Ok(found) : Results.Problem("The plugin holds no such record.", statusCode: 404));
    }
}

/// <summary>The origin and the file name are the plugin (ADR-0012); the folder is where
/// the instance holds that origin's files, and the source folder the mod's repository's, none for Overwrite.</summary>
internal sealed record CreatePluginRequest(string Origin, string Name, string Folder, string? SourceFolder = null);

/// <summary>The mod that provides the plugin (ADR-0012) and its file name.</summary>
internal sealed record CreatePluginInModRequest(string Origin, string Name);

/// <summary>The plugins that list the plugin as a master, and those whose masters could not be read.</summary>
internal sealed record PluginDependantsResponse(IReadOnlyList<PluginAddress> Dependants, IReadOnlyList<PluginAddress> Unreadable);

/// <summary>The plugin the create gesture wrote. Not a plugin row: the Index has not seen
/// it, and nothing registers it.</summary>
internal sealed record PluginCreatedResponse(string Name, string Origin);

/// <summary>The plugin by its origin and file name (ADR-0012), and the file name its source takes.</summary>
internal sealed record RenameSourceChangesRequest(string Origin, string Name, string NewName);

/// <summary>The plugin, the name its tree was filed under before the rename, and the file name its source took.</summary>
internal sealed record MoveLastWrittenRequest(string Origin, string Name, string TreeName, string NewName);

internal sealed record DecompileRequest(IReadOnlyList<PluginAddress> Plugins, bool Force);

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
