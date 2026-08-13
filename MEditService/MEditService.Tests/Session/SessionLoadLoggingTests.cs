using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Session;

// #216: only per-plugin load-progress lines stay at Info in Session/ — every other pipeline-level
// milestone (load start/complete, game-session creation, DuckDB init, conflict-winner computation)
// moves to Debug. These tests assert on log *level* directly via CollectingLoggerProvider; the
// broader Loading/ and Session/ suites (GameSessionTests, GameSessionLoadExplicitTests,
// SessionManagerTests, SessionManagerLoadExplicitTests, SessionManagerThreadSafetyTests) already
// cover pipeline *behavior* and remain the safety net for a regression introduced while touching
// these call sites — none of them assert level, which is why this file exists.
public sealed class SessionLoadLoggingTests
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

    private static SessionManager MakeManager(ILogger<SessionManager> logger)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), logger: logger);
    }

    [Fact]
    public void GameSession_Load_PerPluginLinesAtInfo_PipelineLinesAtDebug()
    {
        using var data = new PluginFixtureBuilder("s216-gs")
            .WithPlugin("A.esp")
            .WithPlugin("B.esp")
            .Build();
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var logger = loggerFactory.CreateLogger(nameof(GameSession));

        using var session = new GameSession(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4, logger);

        Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("A.esp"));
        Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("B.esp"));

        string[] pipelineFragments = ["Load order:", "GameSession ready"];
        foreach (var fragment in pipelineFragments)
        {
            Assert.Contains(entries, e => e.Level == LogLevel.Debug && e.Message.Contains(fragment));
            Assert.DoesNotContain(entries, e => e.Level == LogLevel.Information && e.Message.Contains(fragment));
        }
    }

    [Fact]
    public void SessionManager_Load_PerPluginIndexingAtInfo_PipelineStepsAtDebug()
    {
        using var data = new PluginFixtureBuilder("s216-sm")
            .WithPlugin("A.esp")
            .Build();
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        using var manager = MakeManager(loggerFactory.CreateLogger<SessionManager>());

        manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

        Assert.Contains(entries, e =>
            e.Level == LogLevel.Information && e.Message.Contains("Indexing") && e.Message.Contains("A.esp"));

        string[] pipelineFragments =
        [
            "Session load starting",
            "Creating game session",
            "Game session created",
            "Initializing DuckDB record repository",
            "Computing winners",
            "Session load complete",
        ];
        foreach (var fragment in pipelineFragments)
        {
            Assert.Contains(entries, e => e.Level == LogLevel.Debug && e.Message.Contains(fragment));
            Assert.DoesNotContain(entries, e => e.Level == LogLevel.Information && e.Message.Contains(fragment));
        }
    }

    [Fact]
    public void SessionManager_LoadExplicit_PipelineStepsAtDebug()
    {
        using var fx = new PluginFixtureBuilder("s216-sm-explicit")
            .WithPlugin("A.esp")
            .BuildScattered();
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        using var manager = MakeManager(loggerFactory.CreateLogger<SessionManager>());

        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        string[] pipelineFragments =
        [
            "Explicit session load starting",
            "Creating explicit game session from scattered paths",
            "Explicit session load complete",
        ];
        foreach (var fragment in pipelineFragments)
        {
            Assert.Contains(entries, e => e.Level == LogLevel.Debug && e.Message.Contains(fragment));
            Assert.DoesNotContain(entries, e => e.Level == LogLevel.Information && e.Message.Contains(fragment));
        }
    }
}
