using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

// Only per-plugin progress lines stay at Info; every other pipeline milestone is Debug. Level is
// what these assert, which the broader Plugins suite never does.
public sealed class ReconcileLoggingTests
{
    private static (ILoggerFactory factory, List<LogEntry> entries) CapturingLoggerFactory()
    {
        var entries = new List<LogEntry>();
        var factory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Debug);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        return (factory, entries);
    }

    [Fact]
    public void Reconcile_PerPluginLinesAtInfo_PipelineStepsAtDebug()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("s216")
            .WithPlugin("A.esp")
            .WithPlugin("B.esp")
            .Build();
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        using var index = Indexes.Open(holder, loggerFactory: loggerFactory);

        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);

        foreach (var plugin in new[] { "A.esp", "B.esp" })
        {
            Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("Opening") && e.Message.Contains(plugin));
            Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("Indexing") && e.Message.Contains(plugin));
        }

        string[] pipelineFragments =
        [
            "Reconciling load order",
            "Initializing DuckDB record index",
            "Computing winners",
        ];
        foreach (var fragment in pipelineFragments)
        {
            Assert.Contains(entries, e => e.Level == LogLevel.Debug && e.Message.Contains(fragment));
            Assert.DoesNotContain(entries, e => e.Level == LogLevel.Information && e.Message.Contains(fragment));
        }
        Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("Load order reconciled"));
    }
}
