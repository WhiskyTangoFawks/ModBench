using System.Globalization;
using System.Text.Json.Serialization;
using MEditService.Codec.Fallout4;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Codec.Skyrim;
using MEditService.Codec.Starfield;
using MEditService.Commands.Composition;
using MEditService.Http;
using MEditService.Http.Endpoints;
using MEditService.Http.Notifications;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using Serilog;
using Serilog.Events;

Log.Logger = new LoggerConfiguration()
    .WriteTo.Console(formatProvider: CultureInfo.InvariantCulture)
    .CreateBootstrapLogger();

// The "LocalAppData" env var default is set by LocalizedStrings.EnsureLocalAppDataDefault at every
// Core deep-parse site, before Mutagen ever needs it, so nothing here sets it.

try
{
    GameCodecs.Register(new Dictionary<GameCategory, IGameCodec>
    {
        [GameCategory.Fallout4] = Fallout4Codec.Instance,
        [GameCategory.Skyrim] = SkyrimCodec.Instance,
        [GameCategory.Starfield] = StarfieldCodec.Instance,
    });

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
                    ctx.Configuration["LogDirectory"] ?? Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "mEdit", "logs"),
                    "medit-.log"),
                formatProvider: CultureInfo.InvariantCulture,
                rollingInterval: RollingInterval.Day));

    builder.Services.ConfigureHttpJsonOptions(options =>
        options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
    builder.Services.AddEndpointsApiExplorer();
    // SupportNonNullableReferenceTypes stops marking every reference property nullable but does not
    // touch `required`; NullabilitySchemaFilter does that for value and reference types alike, plus
    // the allOf wrapper a nullable $ref needs under OpenAPI 3.0.
    builder.Services.AddSwaggerGen(o =>
    {
        o.SupportNonNullableReferenceTypes();
        o.SchemaFilter<MEditService.Http.Swagger.NullabilitySchemaFilter>();
    });
    builder.Services.AddProblemDetails();
    builder.Services.AddSingleton(TimeProvider.System);
    builder.Services.AddSingleton<SchemaReflector>();
    // One publisher instance (ADR-0014), resolved as both types: the concrete type for
    // the stream endpoint's own subscribe/unsubscribe, the interface for every publisher.
    builder.Services.AddSingleton<SseNotificationPublisher>();
    builder.Services.AddSingleton<INotificationPublisher>(sp => sp.GetRequiredService<SseNotificationPublisher>());
    builder.Services.AddSingleton<IPluginAdapter, MutagenPluginAdapter>();
    builder.Services.AddSingleton<UnsavedDocuments>();
    builder.Services.AddSingleton<ISourceAdapter, GitSourceAdapter>();
    builder.Services.AddSingleton<IModFolderRepository, ModFolderRepository>();
    builder.Services.AddSingleton<LoadOrderHolder>();
    // One Index for the whole process (ADR-0014). Which file it opens comes from the
    // load request (ADR-0010), not from here.
    builder.Services.AddRecordIndex();
    // The handlers (ADR-0014) are registered where the module they share is visible,
    // and resolved by the route that names the gesture.
    builder.Services.AddCommandHandlers();

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

    app.UseExceptionHandler();
    app.UseSameOriginOnly();
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
    app.MapModEndpoints();
    app.MapRecordEndpoints(app.Services.GetRequiredService<ILoggerFactory>());
    app.MapWorldspaceEndpoints(app.Services.GetRequiredService<ILoggerFactory>());
    app.MapContainerChildEndpoints(app.Services.GetRequiredService<ILoggerFactory>());
    app.MapSubmoduleEndpoints();
    app.MapNotificationEndpoints();
    app.MapIndexEndpoints();
    app.MapUnsavedDocumentEndpoints();

    var lifetime = app.Lifetime;

    // The extension holds this process's stdin open and never writes to it. The OS closes it when the
    // extension host dies, however it dies, so the end of stdin is the end of the window that owns this backend.
    if (app.Configuration.GetValue<bool>("ExitWhenStdinCloses"))
        _ = StopWhenStdinCloses(lifetime);

    try
    {
        await app.RunAsync();
    }
    catch (OperationCanceledException) when (lifetime.ApplicationStopping.IsCancellationRequested)
    {
        return;
    }
}
catch (Exception ex) when (ex is not OutOfMemoryException)
{
    Log.Fatal(ex, "Host terminated unexpectedly");
}
finally
{
    await Log.CloseAndFlushAsync();
}

static async Task StopWhenStdinCloses(IHostApplicationLifetime lifetime)
{
    await using var stdin = Console.OpenStandardInput();
    await stdin.CopyToAsync(Stream.Null);
    lifetime.StopApplication();
}

/// <summary>The entry point a test host names to find this assembly's host builder; top-level
/// statements would otherwise compile it as internal.</summary>
public partial class Program
{
    private Program() { }
}

namespace MEditService.Http
{
    internal sealed record HealthResponse(string Status);
}
