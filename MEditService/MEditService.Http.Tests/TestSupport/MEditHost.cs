using System.Globalization;
using MEditService.TestSupport;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Core;
using Serilog.Events;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>The whole service, hosted in process, logging only to <see cref="Logged"/>. The service's
/// own logger freezes the process's one Serilog bootstrap logger, so a second host fails.</summary>
public sealed class MEditHost(Action<IServiceCollection>? replacing = null) : WebApplicationFactory<Program>
{
    public List<LogEntry> Logged { get; } = [];

    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.ConfigureTestServices(services =>
        {
            services.AddSerilog(
                new LoggerConfiguration().WriteTo.Sink(new CollectingSink(Logged)).CreateLogger(), dispose: true);
            services.AddSingleton(SharedSchemaReflector.Instance);
            replacing?.Invoke(services);
        });

    private sealed class CollectingSink(List<LogEntry> entries) : ILogEventSink
    {
        public void Emit(LogEvent logEvent)
        {
            var entry = new LogEntry(Level(logEvent.Level), logEvent.RenderMessage(CultureInfo.InvariantCulture).Replace("\"", ""), logEvent.Exception);
            lock (entries) entries.Add(entry);
        }

        private static LogLevel Level(LogEventLevel level) => level switch
        {
            LogEventLevel.Verbose => LogLevel.Trace,
            LogEventLevel.Debug => LogLevel.Debug,
            LogEventLevel.Information => LogLevel.Information,
            LogEventLevel.Warning => LogLevel.Warning,
            LogEventLevel.Error => LogLevel.Error,
            _ => LogLevel.Critical,
        };
    }
}
