using System.Globalization;
using System.Text.Json.Serialization;
using MEditService.Api;
using MEditService.Api.Endpoints;
using MEditService.Api.Notifications;
using MEditService.Bridge;
using MEditService.Core.Edits;
using MEditService.Core.Notifications;
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

// The "LocalAppData" env var default is set by LocalizedStrings.EnsureLocalAppDataDefault at every
// Core deep-parse site, before Mutagen ever needs it, so nothing here sets it.

try
{
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions
    {
        Args = args,
        // The extension spawns us without a working directory; the default content root would then
        // silently skip appsettings.json, so config must load from the binary's own directory.
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
    // SupportNonNullableReferenceTypes stops marking every reference property nullable but does not
    // touch `required`; NullabilitySchemaFilter does that for value and reference types alike, plus
    // the allOf wrapper a nullable $ref needs under OpenAPI 3.0.
    builder.Services.AddSwaggerGen(o =>
    {
        o.SupportNonNullableReferenceTypes();
        o.SchemaFilter<MEditService.Api.Swagger.NullabilitySchemaFilter>();
    });
    builder.Services.AddSingleton<SchemaReflector>();
    builder.Services.AddSingleton<TableDdlBuilder>();
    // ADR-0046: one publisher instance, resolved as both types — the concrete type for the stream
    // endpoint's own subscribe/unsubscribe, the interface for every publisher.
    builder.Services.AddSingleton<SseNotificationPublisher>();
    builder.Services.AddSingleton<INotificationPublisher>(sp => sp.GetRequiredService<SseNotificationPublisher>());
    // ADR-0001: the index is a persistent file per MO2 instance, inside the instance root —
    // the load request names it, so there is nothing for the composition root to state here.
    builder.Services.AddSingleton<IRecordIndexFactory, DuckDbRecordIndexFactory>();
    builder.Services.AddSingleton<ConflictClassifier>();
    builder.Services.AddSingleton<PluginWriter>();
    builder.Services.AddSingleton<IModImporter, DefaultModImporter>();
    builder.Services.AddSingleton<ILoadOrderMirror, LoadOrderMirror>();
    // Resolved from the mirror rather than registered on its own, so there is exactly one write
    // gate — a bare `AddSingleton<IndexWriteGate>()` would inject cleanly and serialize nothing.
    builder.Services.AddSingleton(sp => sp.GetRequiredService<ILoadOrderMirror>().WriteGate);
    builder.Services.AddSingleton<IRecordQueryService, RecordQueryService>();
    builder.Services.AddSingleton<MalformedPluginQueryService>();
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

    // ADR-0001: subscribed once, not per reconcile — the watcher is a process singleton, and
    // re-subscribing would stack a handler per reconcile. Which plugins are watched is re-decided
    // per reconcile instead.
    var indexMirror = new IndexMirror(
        app.Services.GetRequiredService<ILoadOrderMirror>(),
        app.Services.GetRequiredService<INotificationPublisher>(),
        app.Services.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(IndexMirror)));
    app.Services.GetRequiredService<ExternalChangeWatcher>().IndexedBinaryChanged = indexMirror.Apply;

    // Most endpoint guards return a 4xx without logging, so without the selector a deliberate failure
    // would be invisible; at Information a success line would flood. The appsettings
    // Microsoft.AspNetCore override is a different category and does not touch this line.
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
    app.MapNotificationEndpoints();

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
