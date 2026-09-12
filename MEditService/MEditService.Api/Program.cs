using System.Globalization;
using System.Text.Json.Serialization;
using MEditService.Api;
using MEditService.Api.Endpoints;
using MEditService.Api.Notifications;
using MEditService.Bridge;
using MEditService.Core.Composition;
using MEditService.Core.Edits;
using MEditService.Core.Notifications;
using MEditService.Core.PluginAdapter;
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
    // ADR-0014: one publisher instance, resolved as both types — the concrete type for the stream
    // endpoint's own subscribe/unsubscribe, the interface for every publisher.
    builder.Services.AddSingleton<SseNotificationPublisher>();
    builder.Services.AddSingleton<INotificationPublisher>(sp => sp.GetRequiredService<SseNotificationPublisher>());
    builder.Services.AddSingleton<ConflictClassifier>();
    builder.Services.AddSingleton<PluginWriter>();
    builder.Services.AddSingleton<IPluginAdapter, MutagenPluginAdapter>();
    builder.Services.AddSingleton<LoadOrderHolder>();
    // ADR-0014 invariant 5: one Index for the whole process, so the two sides never project into
    // two stores. ADR-0009: which file it opens comes from the load request, not from here.
    builder.Services.AddSingleton(sp => new IndexProjector(
        sp.GetRequiredService<LoadOrderHolder>(),
        sp.GetRequiredService<IPluginAdapter>(),
        sp.GetRequiredService<SchemaReflector>(),
        sp.GetRequiredService<ILoggerFactory>(),
        sp.GetRequiredService<INotificationPublisher>()));
    builder.Services.AddSingleton<IQueryIndex>(sp => sp.GetRequiredService<IndexProjector>());
    builder.Services.AddSingleton<IRefreshIndex>(sp => sp.GetRequiredService<IndexProjector>());
    builder.Services.AddSingleton<IRecordQueryService, RecordQueryService>();
    builder.Services.AddSingleton<MalformedPluginQueryService>();
    builder.Services.AddSingleton<IWorldspaceQueryService, WorldspaceQueryService>();
    builder.Services.AddSingleton<ContainerChildQueryService>();
    builder.Services.AddSingleton<RecordTextCodec>();
    builder.Services.AddSingleton<TrackService>();
    // ADR-0014 invariant 3: one handler per gesture, registered where the module they share is
    // visible, and resolved by the route that names the gesture.
    builder.Services.AddCommandHandlers();
    // The write path's other half — source text -> binary.
    builder.Services.AddSingleton<PluginCompileService>();
    // ADR-0014: one recursive watcher per mod folder in the load order, a process singleton so the
    // reconcile-time check (PUT /load-order), Track and the live watch all share it.
    builder.Services.AddSingleton(sp => new ModFolderWatcher(
        sp.GetRequiredService<LoadOrderHolder>(),
        sp.GetRequiredService<IRefreshIndex>(),
        sp.GetRequiredService<INotificationPublisher>(),
        sp.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(ModFolderWatcher))));

    var app = builder.Build();

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
    app.MapIndexEndpoints();

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
