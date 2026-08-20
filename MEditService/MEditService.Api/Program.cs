using System.Globalization;
using System.Text.Json.Serialization;
using Autofac;
using Autofac.Extensions.DependencyInjection;
using MEditService.Api;
using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Serilog;
using Serilog.Events;

Log.Logger = new LoggerConfiguration()
    .WriteTo.Console(formatProvider: CultureInfo.InvariantCulture)
    .CreateBootstrapLogger();

// Mutagen resolves BSA/localized-string archive order via a plugin-listings path keyed off the
// (case-sensitive) "LocalAppData" env var, which is unset on non-Windows hosts. Our sessions are
// always explicit (ADR-0022) and never read this file, but Mutagen throws if it can't determine
// even a hypothetical path, so give it a writable placeholder.
if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LocalAppData")))
    Environment.SetEnvironmentVariable("LocalAppData", Path.GetTempPath());

try
{
    // #343: default content root is the launching process's cwd, not this binary's own directory —
    // the extension spawns us without setting one, so appsettings.json (and its
    // Microsoft.AspNetCore: Warning override) silently never loaded. Anchor to our own directory so
    // every launch mode (dev-attached, extension-spawned) behaves alike.
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions
    {
        Args = args,
        ContentRootPath = AppContext.BaseDirectory,
    });

    builder.Host
        .UseServiceProviderFactory(new AutofacServiceProviderFactory())
        .ConfigureContainer<ContainerBuilder>(_ => { })
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
    builder.Services.AddSingleton<ISchemaReflector, SchemaReflector>();
    builder.Services.AddSingleton<ITableDdlBuilder, TableDdlBuilder>();
    builder.Services.AddSingleton<IRecordIndexFactory, DuckDbRecordIndexFactory>();
    builder.Services.AddSingleton<IConflictClassifier, ConflictClassifier>();
    builder.Services.AddSingleton<PluginWriter>();
    builder.Services.AddSingleton<IModImporter, DefaultModImporter>();
    builder.Services.AddSingleton<ISessionManager, SessionManager>();
    builder.Services.AddSingleton<IRecordQueryService, RecordQueryService>();
    builder.Services.AddSingleton<IWorldspaceQueryService, WorldspaceQueryService>();
    builder.Services.AddSingleton<RecordTextCodec>();
    builder.Services.AddSingleton<TrackService>();
    // #415: the single write path, plus the read-time freshness validation the read model consumes.
    builder.Services.AddSingleton<LedgerFreshness>();
    builder.Services.AddSingleton<RecordEditService>();

    var app = builder.Build();

    // #343: one summary line per request instead of ASP.NET Core's own six-line pipeline log (now
    // silenced by appsettings.json's Microsoft.AspNetCore: Warning override — a different category
    // than this middleware writes under, so the override doesn't touch it and no second override is
    // needed here). The level is what makes it a win rather than a regression: most endpoint guards
    // and StageEditResultExtensions.ToHttpResult return a 4xx without logging anything of their own,
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

    app.MapSessionEndpoints();
    app.MapPluginEndpoints();
    app.MapRecordEndpoints(app.Services.GetRequiredService<ILoggerFactory>());
    app.MapWorldspaceEndpoints(app.Services.GetRequiredService<ILoggerFactory>());

    var cliArgs = CliArgs.Parse(args);
    if (cliArgs.DataFolderPath != null)
    {
        var gameRelease = cliArgs.GameRelease ?? GameRelease.Fallout4;
        var pluginsTxt = cliArgs.PluginsTxtPath ?? AutoDetectPluginsTxt(cliArgs.DataFolderPath, gameRelease);
        if (pluginsTxt != null)
        {
            Log.Information("CLI auto-load: data={DataFolder} plugins={PluginsTxt} game={Game}",
                cliArgs.DataFolderPath, pluginsTxt, gameRelease);
            app.Services.GetRequiredService<ISessionManager>()
                .Load(cliArgs.DataFolderPath, pluginsTxt, gameRelease);
        }
        else
        {
            Log.Warning("--data-folder provided but Plugins.txt could not be found; pass --plugins-txt explicitly");
        }
    }

    await app.RunAsync();

    static string? AutoDetectPluginsTxt(string dataFolderPath, GameRelease gameRelease)
    {
        var gameFolder = gameRelease.ToCategory() switch
        {
            GameCategory.Fallout4 => "Fallout4",
            GameCategory.Skyrim => "Skyrim Special Edition",
            GameCategory.Oblivion => "Oblivion",
            GameCategory.Starfield => "Starfield",
            _ => null
        };

        return gameFolder switch
        {
            null => null,
            _ when OperatingSystem.IsWindows() => Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                gameFolder, "Plugins.txt"),
            _ => FindProtonPluginsTxt(dataFolderPath, gameRelease, gameFolder),
        };
    }

    // Linux/Proton: data folder is {steamLibrary}/steamapps/common/{Game}/Data
    // Plugins.txt lives under {steamLibrary}/steamapps/compatdata/{appId}/pfx/...
    static string? FindProtonPluginsTxt(string dataFolderPath, GameRelease gameRelease, string gameFolder)
    {
        var steamAppId = gameRelease.ToCategory() switch
        {
            GameCategory.Fallout4 => "377160",
            GameCategory.Skyrim => "489830",
            GameCategory.Starfield => "1716740",
            _ => null
        };

        if (steamAppId == null) return null;

        var steamapps = Path.GetFullPath(Path.Combine(dataFolderPath, "..", "..", ".."));
        var candidate = Path.Combine(steamapps, "compatdata", steamAppId, "pfx",
            "drive_c", "users", "steamuser", "AppData", "Local", gameFolder, "Plugins.txt");
        return File.Exists(candidate) ? candidate : null;
    }
}
catch (Exception ex)
{
    Log.Fatal(ex, "Host terminated unexpectedly");
}
finally
{
    await Log.CloseAndFlushAsync();
}
