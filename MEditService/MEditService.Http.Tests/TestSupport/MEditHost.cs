using System.Globalization;
using MEditService.TestSupport;
using MEditService.Watcher;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Serilog;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>The whole service, hosted in process: <paramref name="collectedLogs"/> is a test oracle
/// over the watcher's Debug output; <paramref name="clock"/> replaces its clock.</summary>
public sealed class MEditHost(List<LogEntry>? collectedLogs = null, TimeProvider? clock = null) : WebApplicationFactory<Program>
{
    // Program.cs creates the watcher's own logger with this same name; deriving it here means a
    // rename of ModFolderWatcher moves this category with it instead of silently missing its logs.
    internal static readonly string WatcherLogCategory = nameof(ModFolderWatcher);

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        if (collectedLogs is not null)
        {
            // The minimum level for the watcher's category is Serilog's own to set (below): a
            // provider-level filter here never sees what Serilog already dropped.
            builder.ConfigureLogging(logging => logging.AddProvider(new CollectingLoggerProvider(collectedLogs)));
        }

        // Registered after Program.cs's own TimeProvider.System singleton, so this is the one
        // every consumer, the watcher included, resolves.
        if (clock is { } fakeClock) builder.ConfigureServices(services => services.AddSingleton(fakeClock));
    }

    protected override IHost CreateHost(IHostBuilder builder)
    {
        if (collectedLogs is not null)
        {
            builder.UseSerilog((ctx, services, cfg) => cfg
                .ReadFrom.Configuration(ctx.Configuration)
                .ReadFrom.Services(services)
                .MinimumLevel.Override(WatcherLogCategory, Serilog.Events.LogEventLevel.Debug)
                .WriteTo.Console(formatProvider: CultureInfo.InvariantCulture),
                writeToProviders: true);
        }
        return base.CreateHost(builder);
    }
}
