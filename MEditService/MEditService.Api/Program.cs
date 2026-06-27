using System.Globalization;
using System.Text.Json.Serialization;
using Autofac;
using Autofac.Extensions.DependencyInjection;
using MEditService.Api;
using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Serilog;

Log.Logger = new LoggerConfiguration()
    .WriteTo.Console(formatProvider: CultureInfo.InvariantCulture)
    .CreateBootstrapLogger();

try
{
    var builder = WebApplication.CreateBuilder(args);

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
                rollingInterval: RollingInterval.Day,
                formatProvider: CultureInfo.InvariantCulture));

    builder.Services.AddCors(opts =>
        opts.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));
    builder.Services.ConfigureHttpJsonOptions(options =>
        options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
    builder.Services.AddEndpointsApiExplorer();
    builder.Services.AddSwaggerGen();
    builder.Services.AddSingleton<ISchemaReflector, SchemaReflector>();
    builder.Services.AddSingleton<ITableDdlBuilder, TableDdlBuilder>();
    builder.Services.AddSingleton<IRecordRepositoryFactory, DuckDbRecordRepositoryFactory>();
    builder.Services.AddSingleton<IConflictClassifier, ConflictClassifier>();
    builder.Services.AddSingleton<IPluginWriter, PluginWriter>();
    builder.Services.AddSingleton<IModImporter, DefaultModImporter>();
    builder.Services.AddSingleton<ISessionManager, SessionManager>();
    builder.Services.AddSingleton<DuckDbPendingChangeService>();
    builder.Services.AddSingleton<IPendingChangeService>(sp => sp.GetRequiredService<DuckDbPendingChangeService>());
    builder.Services.AddSingleton<IRecordQueryService, RecordQueryService>();
    builder.Services.AddSingleton<IWorldspaceQueryService, WorldspaceQueryService>();
    builder.Services.AddSingleton<IEditOrchestrator, EditOrchestrator>();
    builder.Services.AddSingleton<PluginSaver>();

    var app = builder.Build();

    app.UseCors();
    app.UseSwagger();
    app.UseSwaggerUI(c =>
    {
        c.SwaggerEndpoint("/swagger/v1/swagger.json", "mEdit API");
        c.RoutePrefix = "swagger";
    });

    app.MapGet("/health", () => Results.Ok(new { status = "ok" }))
        .WithName("Health")
        .WithTags("Health");

    app.MapSessionEndpoints();
    app.MapPluginEndpoints();
    app.MapRecordEndpoints(app.Services.GetRequiredService<ILoggerFactory>());
    app.MapWorldspaceEndpoints(app.Services.GetRequiredService<ILoggerFactory>());
    app.MapChangeEndpoints();

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

        if (gameFolder == null) return null;

        if (OperatingSystem.IsWindows())
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                gameFolder, "Plugins.txt");
        }

        // Linux/Proton: data folder is {steamLibrary}/steamapps/common/{Game}/Data
        // Plugins.txt lives under {steamLibrary}/steamapps/compatdata/{appId}/pfx/...
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
