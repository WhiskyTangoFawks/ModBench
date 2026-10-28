using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;

namespace MEditService.Http.Endpoints;

internal static class PluginEndpoints
{
    private const string Tag = "Plugins";

    public static IEndpointRouteBuilder MapPluginEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/plugins", (IQueries svc) =>
            EndpointMapping.Ok(svc.GetPlugins()))
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
                "record: a reference to a record neither it nor an active plugin holds. Answers only once the record index is ready.")
            .Produces<IReadOnlyList<PluginProblems>>()
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/dependants", (string plugin, string? origin, IQueries svc) =>
        {
            if (!EndpointMapping.PluginAt(plugin, origin, out var address, out var refused)) return refused;
            return EndpointMapping.Ok(svc.GetDependants(address));
        })
            .WithName("GetPluginDependants")
            .WithTags(Tag)
            .WithDescription(
                "The plugins that list the plugin's file name as a master, and the plugins whose masters " +
                "mEdit could not read. Answers only once the record index is ready.")
            .Produces<PluginDependants>()
            .ProducesProblem(400)
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/indexed-as-on-disk", (string plugin, string? origin, IQueries svc) =>
        {
            if (!EndpointMapping.PluginAt(plugin, origin, out var address, out var refused)) return refused;
            return EndpointMapping.Ok(svc.GetPluginIndexedAsOnDisk(address));
        })
            .WithName("GetPluginIndexedAsOnDisk")
            .WithTags(Tag)
            .WithDescription(
                "Whether the record index's rows for the plugin were built from the file now on disk; " +
                "false when the file changed since, or the record index holds no rows for it.")
            .Produces<bool>()
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

        app.MapGet("/plugins/creatable-extensions", (IQueries svc) =>
            EndpointMapping.Ok(svc.GetCreatablePluginExtensions()))
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
            .Produces<PluginAddress>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(503);

        app.MapPost("/plugins/create-in-mod", CreatePluginInMod)
            .WithName("CreatePluginInMod")
            .WithTags(Tag)
            .WithDescription(
                "Writes an empty plugin into the folder of an enabled mod or Overwrite the held load order " +
                "names as a place, by its origin, with plugin source only in a mod that is already a source " +
                "mod. Refuses any other origin.")
            .Produces<PluginAddress>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(503);

        app.MapPost("/plugins/decompile", Decompile)
            .WithName("DecompilePlugin")
            .WithTags(Tag)
            .Produces<DecompileResult>()
            .ProducesProblem(400)
            // git missing refuses the whole selection; every other refusal is an item of the answer.
            .ProducesProblem(500)
            .ProducesProblem(503);

        app.MapPost("/plugins/repair-previews", RepairPreviews)
            .WithName("RepairPreviews")
            .WithTags(Tag)
            .WithSummary("Each malformed plugin's diagnoses and the change that repairs each, writing nothing.")
            .Produces<RepairPreviewsResult>()
            .ProducesProblem(400)
            .ProducesProblem(503);

        app.MapPost("/plugins/decompile-and-repair", DecompileAndRepair)
            .WithName("DecompileAndRepairPlugin")
            .WithTags(Tag)
            .WithDescription(
                "Writes each malformed plugin's source as two commits: its malformed records flagged, then repaired. A plugin " +
                "is named with the hash its preview answered, and refused when its bytes changed since.")
            .Produces<DecompileAndRepairResult>()
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
            .Produces<RenameSourceChanges>()
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
            .ProducesProblem(422)
            .ProducesProblem(500)
            .ProducesProblem(503);

        // A missing load order refuses the whole selection once; every other refusal is an item of
        // the answer.
        app.MapPost("/plugins/compile", Compile)
            .WithName("CompilePlugin")
            .WithTags(Tag)
            .Produces<CompileResult>()
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
            .Produces<CreateRecordChanges>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(500)
            .ProducesProblem(503);

        app.MapPost("/plugins/{plugin}/create-record", CreateRecord)
            .WithName("CreateRecord")
            .WithSummary("Writes a new record to plugin source: a script's create.")
            .WithDescription(
                "Writes to the working tree what the same creation's changes answer, an unsaved document read in place " +
                "of its file. Answers the new FormKey. A creation that would write a file held unsaved is refused " +
                "naming it, and nothing is written.")
            .WithTags(Tag)
            .Produces<RecordWritten>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422)
            .ProducesProblem(500)
            .ProducesProblem(503);

        return app;
    }

    internal static IResult CreateRecord(
        string plugin, RecordCreateChangesRequest req, CreateRecordHandler creates, ILoggerFactory loggerFactory)
    {
        if (!EndpointMapping.PluginAt(plugin, req.Origin, out var address, out var refused)) return refused;
        return RecordTypeProblem(req) ?? EndpointMapping.Answered(
            "CreateRecord", loggerFactory.CreateLogger(nameof(PluginEndpoints)),
            creates.Create(address, req.RecordType, req.Container, req.Position), Results.Ok);
    }

    private static IResult? RecordTypeProblem(RecordCreateChangesRequest req) =>
        string.IsNullOrWhiteSpace(req.RecordType) ? EndpointMapping.BadRequest("A record type is required.") : null;

    internal static async Task<IResult> CreatePlugin(
        CreatePluginRequest req, CreatePluginHandler create, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (Malformed(req) is { } malformed) return malformed;

        var plugin = new PluginAddress(req.Name, req.Origin);
        return EndpointMapping.Answered("Create plugin", logger, plugin, await create.CreatePlugin(plugin, req.Folder, req.SourceFolder));
    }

    internal static async Task<IResult> CreatePluginInMod(
        CreatePluginInModRequest req, CreatePluginInModHandler create, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        if (RenamedPlugin(req.Name, req.Origin) is not { } plugin) return EndpointMapping.BadRequest("Plugin name and origin are required.");

        return EndpointMapping.Answered("Create plugin in mod", logger, plugin, await create.CreatePluginIn(plugin.Origin, plugin.Name));
    }

    // The refusals a malformed request earns, taken before the door so a name that could never be
    // a plugin file writes nothing.
    private static IResult? Malformed(CreatePluginRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Name))
            return EndpointMapping.BadRequest("Plugin name is required.");
        return string.IsNullOrWhiteSpace(req.Folder) || string.IsNullOrWhiteSpace(req.Origin)
            ? EndpointMapping.BadRequest("The folder and the origin are required.")
            : null;
    }

    internal static IResult RenameSourceChanges(
        RenameSourceChangesRequest req, RenameSourceChangesHandler rename, ILoggerFactory loggerFactory)
    {
        if (RenamedPlugin(req.Name, req.Origin) is not { } plugin) return EndpointMapping.BadRequest("Plugin name and origin are required.");

        return EndpointMapping.Answered(
            "Rename source", loggerFactory.CreateLogger(nameof(PluginEndpoints)), plugin, rename.RenameSource(plugin, req.NewName ?? string.Empty));
    }

    internal static IResult MoveLastWritten(
        MoveLastWrittenRequest req, MoveLastWrittenHandler move, ILoggerFactory loggerFactory)
    {
        if (RenamedPlugin(req.Name, req.Origin) is not { } plugin || string.IsNullOrWhiteSpace(req.TreeName))
            return EndpointMapping.BadRequest("Plugin name, origin and tree name are required.");

        return EndpointMapping.Answered(
            "Move last written", loggerFactory.CreateLogger(nameof(PluginEndpoints)), plugin,
            move.MoveLastWritten(plugin, req.TreeName, req.NewName ?? string.Empty));
    }

    private static PluginAddress? RenamedPlugin(string? name, string? origin) =>
        string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(origin) ? null : new PluginAddress(name, origin);

    // decompile-plugin: the selection (commands.md, A selection is one gesture).
    internal static Task<IResult> Decompile(
        DecompileRequest req, DecompilePluginHandler decompileHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        return OverPlugins(req.Plugins, plugins => EndpointMapping.Answered(
            "Decompile", logger, decompileHandler.DecompileAsync(plugins, req.Force), EndpointMapping.Refusal));
    }

    internal static Task<IResult> RepairPreviews(
        RepairPreviewsRequest req, RepairPreviewsHandler previewsHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        return OverPlugins(req.Plugins, plugins => EndpointMapping.Answered(
            "Repair previews", logger, previewsHandler.PreviewAsync(plugins), EndpointMapping.Refusal));
    }

    internal static Task<IResult> DecompileAndRepair(
        DecompileAndRepairRequest req, DecompileAndRepairPluginHandler repairHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        var requested = req.Plugins ?? [];
        if (requested.Any(p => string.IsNullOrWhiteSpace(p.Hash)))
            return Task.FromResult(EndpointMapping.BadRequest("Every plugin needs the hash its preview answered."));
        return OverPlugins([.. requested.Select(p => p.Plugin)], _ => EndpointMapping.Answered(
            "Decompile and repair", logger,
            repairHandler.DecompileAndRepairAsync(
                [.. requested.Select(p => new PluginToRepair(p.Plugin, p.Hash, p.SourceFolder))], req.MetadataFiles ?? [], req.Force, req.AgreedDrops),
            EndpointMapping.Refusal));
    }

    // compile-plugin: the selection (commands.md, A selection is one gesture).
    internal static Task<IResult> Compile(
        CompileRequest req, CompilePluginHandler compileHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        return OverPlugins(req.Plugins, plugins => EndpointMapping.Answered(
            "Compile", logger,
            compileHandler.CompileAsync(plugins),
            EndpointMapping.Refusal));
    }

    // The routes over a selection of plugins share their request's shape.
    private static async Task<IResult> OverPlugins(
        IReadOnlyList<PluginAddress>? requested,
        Func<IReadOnlyList<PluginAddress>, Task<IResult>> answer)
    {
        var plugins = requested ?? [];
        if (plugins.Count == 0)
            return EndpointMapping.BadRequest("At least one plugin is required.");
        if (plugins.Any(p => string.IsNullOrWhiteSpace(p.Name) || string.IsNullOrWhiteSpace(p.Origin)))
            return EndpointMapping.BadRequest("Every plugin needs a name and an origin.");

        return await answer(plugins);
    }

    // logReceived is null on purpose: no PluginEndpoints handler logs on entry,
    // UseSerilogRequestLogging's per-request summary covers it.
    internal static IResult CreateRecordChanges(
        string plugin, RecordCreateChangesRequest req, CreateRecordChangesHandler edits, ILoggerFactory loggerFactory)
    {
        if (!EndpointMapping.PluginAt(plugin, req.Origin, out var address, out var refused)) return refused;
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        return RecordTypeProblem(req) ?? EndpointMapping.Answered(
            "Create record", logger, edits.CreateRecord(address, req.RecordType, req.Container, req.Position), Results.Ok);
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

/// <summary>The plugin by its origin and file name (ADR-0012), and the file name its source takes.</summary>
internal sealed record RenameSourceChangesRequest(string Origin, string Name, string NewName);

/// <summary>The plugin, the name its tree was filed under before the rename, and the file name its source took.</summary>
internal sealed record MoveLastWrittenRequest(string Origin, string Name, string TreeName, string NewName);

internal sealed record DecompileRequest(IReadOnlyList<PluginAddress> Plugins, bool Force);

internal sealed record CompileRequest(IReadOnlyList<PluginAddress> Plugins);

internal sealed record RepairPreviewsRequest(IReadOnlyList<PluginAddress> Plugins);

/// <summary>The mod manager's own files are what a repository made for a mod with none leaves out of its assets.</summary>
internal sealed record DecompileAndRepairRequest(IReadOnlyList<PluginToRepairRequest> Plugins, IReadOnlyList<string>? MetadataFiles, bool Force, bool AgreedDrops = false);

/// <summary>A plugin, the hash its preview answered, and the source folder a repository for its mod is made in when it has none.</summary>
internal sealed record PluginToRepairRequest(PluginAddress Plugin, string Hash, string? SourceFolder);

/// <summary>Container is the FormKey, in the plugin the request names, of the record the new one goes into;
/// Position is an exterior cell's grid position, and only a worldspace takes one.</summary>
internal sealed record RecordCreateChangesRequest(
    string Origin, string RecordType, string? Container = null, GridPosition? Position = null);
