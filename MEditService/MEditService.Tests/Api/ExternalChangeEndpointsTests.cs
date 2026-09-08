using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>Thin, mapping-only assertions over Source/Bridge machinery those layers already test;
/// not a re-derivation of every Source-level scenario.</summary>
public sealed class ExternalChangeEndpointsTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();
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
        var mod = new Fallout4Mod(ModKey.FromFileName(IndexedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("FixtureRace");
        mod.Keywords.AddNew("FixtureKeyword");
        var npc = mod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = newHeightMax;
        mod.Npcs.AddNew("UntouchedNpc");
        mod.WriteToBinary(Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName));
    }

    [Fact]
    public void ExternalChangeStatus_ReportsAWatcherQueuedQuestion_WithItsOriginResolved()
    {
        var watcher = new ExternalChangeWatcher();
        watcher.ReportExternalChange(_mod.ModFolder, IndexedModFixture.PluginName,
            new ExternalChangeClassification.ExternalChange(true, "1.0", "2.0"));

        var result = PluginEndpoints.ExternalChangeStatus(watcher, _mod.Mirror.Projector);

        var ok = Assert.IsAssignableFrom<Ok<List<UnansweredExternalChangeResponse>>>(result);
        var unanswered = Assert.Single(ok.Value!);
        Assert.Equal(IndexedModFixture.PluginName, unanswered.Plugin);
        Assert.Equal(IndexedModFixture.ModFolderOrigin, unanswered.Origin);
        Assert.True(unanswered.MetaChanged);
        Assert.Equal("1.0", unanswered.OldVersion);
        Assert.Equal("2.0", unanswered.NewVersion);
    }

    [Fact]
    public void AbsorbExternalChange_AbsorbsAndClearsTheUnansweredQuestion()
    {
        WriteExternalBinaryChange(0.9f);
        var watcher = new ExternalChangeWatcher();
        watcher.ReportExternalChange(_mod.ModFolder, IndexedModFixture.PluginName,
            new ExternalChangeClassification.ExternalChange(false, null, null));
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.AbsorbExternalChange(
            IndexedModFixture.PluginName, new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin),
            _mod.Mirror.Projector, watcher, loggerFactory);

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
            IndexedModFixture.PluginName, new ExternalChangeActionRequest("NoSuchOrigin"),
            _mod.Mirror.Projector, new ExternalChangeWatcher(), loggerFactory);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(503, problem.StatusCode);
    }

    [Fact]
    public void KeepExternalChange_RefusalTravelsAsA200_NamingTheCollidingRecord()
    {
        var editService = MEditService.Tests.TestSupport.TestEditService.Over(_mod.Mirror);
        editService.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax",
            System.Text.Json.JsonDocument.Parse("0.5").RootElement);
        WriteExternalBinaryChange(0.9f);
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.KeepExternalChange(
            IndexedModFixture.PluginName, new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin),
            _mod.Mirror.Projector, new ExternalChangeWatcher(), SharedSchemaReflector.Instance, loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(result);
        Assert.False(ok.Value!.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), ok.Value.RefusalReason, StringComparison.Ordinal);
    }

    [Fact]
    public void Rebase_UnknownOrigin_Returns404()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.Rebase(new RebaseRequest("NoSuchOrigin"), _mod.Mirror.Projector, loggerFactory);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(404, problem.StatusCode);
    }

    [Fact]
    public void Rebase_CleanRepo_ReportsCleanOutcome()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.Rebase(new RebaseRequest(IndexedModFixture.ModFolderOrigin), _mod.Mirror.Projector, loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<RebaseResponse>>(result);
        Assert.Equal(RebaseOutcome.Clean, ok.Value!.Outcome);
    }
}
