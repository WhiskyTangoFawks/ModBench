using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.Session;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>
/// #417 B12: the HTTP door over the Source/Bridge machinery those layers already test exhaustively —
/// thin, mapping-only assertions per this run's plan (resolve target, call through, shape the
/// response), not a re-derivation of every Source-level scenario.
/// </summary>
public sealed class ExternalChangeEndpointsTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();
    private static (ILoggerFactory factory, List<LogEntry> entries) CapturingLoggerFactory()
    {
        var entries = new List<LogEntry>();
        var factory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Information);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        return (factory, entries);
    }

    public void Dispose() => _mod.Dispose();

    private void WriteExternalBinaryChange(float newHeightMax)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("FixtureRace");
        mod.Keywords.AddNew("FixtureKeyword");
        var npc = mod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = newHeightMax;
        mod.Npcs.AddNew("UntouchedNpc");
        mod.WriteToBinary(Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName));
    }

    [Fact]
    public void ExternalChangeStatus_ReportsAWatcherQueuedQuestion_WithItsOriginResolved()
    {
        var watcher = new ExternalChangeWatcher();
        watcher.ReportExternalChange(_mod.ModFolder, TrackedModFixture.PluginName,
            new ExternalChangeClassification.ExternalChange(true, "1.0", "2.0"));

        var result = PluginEndpoints.ExternalChangeStatus(watcher, _mod.Sessions);

        var ok = Assert.IsAssignableFrom<Ok<List<UnansweredExternalChangeResponse>>>(result);
        var unanswered = Assert.Single(ok.Value!);
        Assert.Equal(TrackedModFixture.PluginName, unanswered.Plugin);
        Assert.Equal(TrackedModFixture.ModFolderOrigin, unanswered.Origin);
        Assert.True(unanswered.MetaChanged);
        Assert.Equal("1.0", unanswered.OldVersion);
        Assert.Equal("2.0", unanswered.NewVersion);
    }

    [Fact]
    public void AbsorbExternalChange_AbsorbsAndClearsTheUnansweredQuestion()
    {
        WriteExternalBinaryChange(0.9f);
        var watcher = new ExternalChangeWatcher();
        watcher.ReportExternalChange(_mod.ModFolder, TrackedModFixture.PluginName,
            new ExternalChangeClassification.ExternalChange(false, null, null));
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.AbsorbExternalChange(
            TrackedModFixture.PluginName, new ExternalChangeActionRequest(TrackedModFixture.ModFolderOrigin),
            _mod.Sessions, watcher, loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(result);
        Assert.True(ok.Value!.Succeeded);
        Assert.Empty(watcher.Unanswered());
    }

    [Fact]
    public void AbsorbExternalChange_UnknownOrigin_Returns503()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.AbsorbExternalChange(
            TrackedModFixture.PluginName, new ExternalChangeActionRequest("NoSuchOrigin"),
            _mod.Sessions, new ExternalChangeWatcher(), loggerFactory);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(503, problem.StatusCode);
    }

    [Fact]
    public void KeepExternalChange_RefusalTravelsAsA200_NamingTheCollidingRecord()
    {
        var editService = new MEditService.Core.Edits.RecordEditService(
            _mod.Sessions, SharedSchemaReflector.Instance, Microsoft.Extensions.Logging.Abstractions.NullLogger<MEditService.Core.Edits.RecordEditService>.Instance);
        editService.EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max",
            System.Text.Json.JsonDocument.Parse("0.5").RootElement);
        WriteExternalBinaryChange(0.9f);
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.KeepExternalChange(
            TrackedModFixture.PluginName, new ExternalChangeActionRequest(TrackedModFixture.ModFolderOrigin),
            _mod.Sessions, new ExternalChangeWatcher(), SharedSchemaReflector.Instance, loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(result);
        Assert.False(ok.Value!.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), ok.Value.RefusalReason, StringComparison.Ordinal);
    }

    [Fact]
    public void Rebase_UnknownOrigin_Returns404()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.Rebase(new RebaseRequest("NoSuchOrigin"), _mod.Sessions, loggerFactory);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(404, problem.StatusCode);
    }

    [Fact]
    public void Rebase_CleanRepo_ReportsCleanOutcome()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.Rebase(new RebaseRequest(TrackedModFixture.ModFolderOrigin), _mod.Sessions, loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<RebaseResponse>>(result);
        Assert.Equal(nameof(RebaseOutcome.Clean), ok.Value!.Outcome);
    }
}
