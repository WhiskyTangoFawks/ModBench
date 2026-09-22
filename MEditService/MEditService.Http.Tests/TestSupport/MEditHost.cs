using System.Globalization;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Serilog;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>The whole service, hosted in process. A caller that names <paramref name="collectedLogs"/>
/// gets the watcher's own Debug output as a test oracle; nobody else's logging changes.</summary>
public sealed class MEditHost(List<LogEntry>? collectedLogs = null) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        if (collectedLogs is null) return;
        // The minimum level for ModFolderWatcher's category is Serilog's own to set (below): a
        // provider-level filter here never sees what Serilog already dropped.
        builder.ConfigureLogging(logging => logging.AddProvider(new CollectingLoggerProvider(collectedLogs)));
    }

    protected override IHost CreateHost(IHostBuilder builder)
    {
        if (collectedLogs is not null)
        {
            builder.UseSerilog((ctx, services, cfg) => cfg
                .ReadFrom.Configuration(ctx.Configuration)
                .ReadFrom.Services(services)
                .MinimumLevel.Override("ModFolderWatcher", Serilog.Events.LogEventLevel.Debug)
                .WriteTo.Console(formatProvider: CultureInfo.InvariantCulture),
                writeToProviders: true);
        }
        return base.CreateHost(builder);
    }
}
