using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

// #216: only per-plugin progress lines stay at Info — every other pipeline-level milestone
// (reconcile start, DuckDB init, conflict-winner computation) is Debug. These tests assert on log
// *level* directly via CollectingLoggerProvider; the broader Plugins/ suite covers
// pipeline *behavior* and remain the safety net for a regression introduced while touching these
// call sites — none of them assert level, which is why this file exists.
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
        using var data = new PluginFixtureBuilder("s216")
            .WithPlugin("A.esp")
            .WithPlugin("B.esp")
            .Build();
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var reflector = SharedSchemaReflector.Instance;
        using var mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)), loggerFactory.CreateLogger<LoadOrderMirror>());

        mirror.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);

        foreach (var plugin in new[] { "A.esp", "B.esp" })
        {
            Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("Opening") && e.Message.Contains(plugin));
            Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("Indexing") && e.Message.Contains(plugin));
        }

        string[] pipelineFragments =
        [
            "Reconciling load order",
            "Initializing DuckDB record repository",
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
