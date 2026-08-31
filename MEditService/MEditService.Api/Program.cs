using System.Globalization;
using System.Text.Json.Serialization;
using MEditService.Api;
using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Serilog;
using Serilog.Events;

Log.Logger = new LoggerConfiguration()
    .WriteTo.Console(formatProvider: CultureInfo.InvariantCulture)
    .CreateBootstrapLogger();

// The "LocalAppData" env var default lives in LocalizedStrings.EnsureLocalAppDataDefault, called
// from every Core deep-parse call site (Source.LocalizedStrings.ForRead) before Mutagen ever
// needs it — no reconcile runs (and no Mutagen call at all) before this process's first plugin
// parse, so nothing here needs to set it up front.

try
{
    // Default content root is the launching process's cwd, not this binary's own directory —
    // the extension spawns us without setting one, so appsettings.json (and its
    // Microsoft.AspNetCore: Warning override) silently never loaded. Anchor to our own directory so
    // every launch mode (dev-attached, extension-spawned) behaves alike.
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions
    {
        Args = args,
        ContentRootPath = AppContext.BaseDirectory,
    });

    builder.Host
        .UseSerilog((ctx, services, cfg) => cfg
            .ReadFrom.Configuration(ctx.Configuration)
            .ReadFrom.Services(services)
            .Enrich.FromLogContext()
            .WriteTo.Console(formatProvider: CultureInfo.InvariantCulture)
            .WriteTo.File(
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "mEdit", "logs", "medit-.log"),
                formatProvider: CultureInfo.InvariantCulture,
                rollingInterval: RollingInterval.Day));

    builder.Services.AddCors(opts =>
        opts.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));
    builder.Services.ConfigureHttpJsonOptions(options =>
        options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
    builder.Services.AddEndpointsApiExplorer();
    builder.Services.AddSwaggerGen(o => o.SchemaFilter<MEditService.Api.Swagger.NullableRefSchemaFilter>());
    builder.Services.AddSingleton<SchemaReflector>();
    builder.Services.AddSingleton<TableDdlBuilder>();
    // ADR-0001: the index is a persistent file per MO2 instance, inside the instance root —
    // the load request names it, so there is nothing for the composition root to state here.
    builder.Services.AddSingleton<IRecordIndexFactory, DuckDbRecordIndexFactory>();
    builder.Services.AddSingleton<ConflictClassifier>();
    builder.Services.AddSingleton<PluginWriter>();
    builder.Services.AddSingleton<IModImporter, DefaultModImporter>();
    builder.Services.AddSingleton<ILoadOrderMirror, LoadOrderMirror>();
    builder.Services.AddSingleton<IRecordQueryService, RecordQueryService>();
    builder.Services.AddSingleton<IWorldspaceQueryService, WorldspaceQueryService>();
    builder.Services.AddSingleton<ContainerChildQueryService>();
    builder.Services.AddSingleton<RecordTextCodec>();
    builder.Services.AddSingleton<TrackService>();
    // The single write path, plus the read-time freshness validation the read model consumes.
    builder.Services.AddSingleton<SourceFreshness>();
    builder.Services.AddSingleton<RecordEditService>();
    // The write path's other half — source text -> binary.
    builder.Services.AddSingleton<PluginCompileService>();
    // The bridge's own live-watch lifecycle and unanswered-question queue — one instance for the
    // whole process, so the reconcile-time check (PUT /load-order) and the live watcher share it.
    builder.Services.AddSingleton<ExternalChangeWatcher>();

    var app = builder.Build();

    // ADR-0001: the index keeps mirroring the disk while a load order is held. Subscribed
    // once here rather than per reconcile — the watcher is a process singleton, and re-subscribing
    // on every reconcile would stack a handler per reconcile; which plugins are watched is re-decided
    // per reconcile instead (ExternalChangeLoadOrderHook.RunAfterReconcile).
    var indexMirror = new IndexMirror(
        app.Services.GetRequiredService<ILoadOrderMirror>(),
        app.Services.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(IndexMirror)));
    app.Services.GetRequiredService<ExternalChangeWatcher>().IndexedBinaryChanged = indexMirror.Apply;

    // One summary line per request instead of ASP.NET Core's own six-line pipeline log (now
    // silenced by appsettings.json's Microsoft.AspNetCore: Warning override — a different category
    // than this middleware writes under, so the override doesn't touch it and no second override is
    // needed here). The level is what makes it a win rather than a regression: most endpoint guards
    // and the RecordEditRefusal → ProblemDetails mapping return a 4xx without logging anything of their own,
    // so without an explicit selector a deliberate failure would be invisible; with the default
    // (Information), a success line would flood right back in at one line/request.
    app.UseSerilogRequestLogging(opts => opts.GetLevel = RequestLogLevel);

    static LogEventLevel RequestLogLevel(HttpContext ctx, double _, Exception? ex) => ex switch
    {
        not null => LogEventLevel.Error,
        null when ctx.Response.StatusCode >= 500 => LogEventLevel.Error,
        null when ctx.Response.StatusCode >= 400 => LogEventLevel.Warning,
        _ => LogEventLevel.Debug,
    };

    app.UseCors();
    app.UseSwagger();
    app.UseSwaggerUI(c =>
    {
        c.SwaggerEndpoint("/swagger/v1/swagger.json", "mEdit API");
        c.RoutePrefix = "swagger";
    });

    app.MapGet("/health", () => Results.Ok(new HealthResponse("ok")))
        .WithName("Health")
        .WithTags("Health");

    app.MapLoadOrderEndpoints();
    app.MapPluginEndpoints();
    app.MapRecordEndpoints(app.Services.GetRequiredService<ILoggerFactory>());
    app.MapWorldspaceEndpoints(app.Services.GetRequiredService<ILoggerFactory>());
    app.MapContainerChildEndpoints(app.Services.GetRequiredService<ILoggerFactory>());

    await app.RunAsync();
}
catch (Exception ex)
{
    Log.Fatal(ex, "Host terminated unexpectedly");
}
finally
{
    await Log.CloseAndFlushAsync();
}
