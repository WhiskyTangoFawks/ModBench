using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Http.Endpoints;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
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
    public void AbsorbExternalChange_AbsorbsAndClearsTheUnansweredQuestion()
    {
        WriteExternalBinaryChange(0.9f);
        var watcher = TestWatcher.Inert();
        SourceRepository.RaiseExternalChangeQuestion(_mod.ModFolder, "unanswered");
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.AbsorbExternalChange(new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin),
            _mod.Holder, TestEditService.AbsorbHandler(), watcher, loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(result);
        var response = ok.Value;
        Assert.NotNull(response);
        Assert.True(response.Succeeded);
        Assert.Null(SourceRepository.UnansweredExternalChange(_mod.ModFolder));
    }

    [Fact]
    public void AbsorbExternalChange_UnknownOrigin_Returns503()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.AbsorbExternalChange(new ExternalChangeActionRequest("NoSuchOrigin"),
            _mod.Holder, TestEditService.AbsorbHandler(), TestWatcher.Inert(), loggerFactory);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(503, problem.StatusCode);
    }

    // The same 200-with-a-refusal posture Keep already has: an unparseable binary is an answer the
    // dialog can show, and the question stays unanswered so the user can still choose Keep.
    [Fact]
    public void AbsorbExternalChange_RefusalTravelsAsA200_LeavingTheQuestionUnanswered()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName);
        File.WriteAllBytes(pluginPath, [0x00, 0x01, 0x02, 0x03]);
        var watcher = TestWatcher.Inert();
        SourceRepository.RaiseExternalChangeQuestion(_mod.ModFolder, "unanswered");
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.AbsorbExternalChange(new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin),
            _mod.Holder, TestEditService.AbsorbHandler(), watcher, loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(result);
        var response = ok.Value;
        Assert.NotNull(response);
        Assert.False(response.Succeeded);
        Assert.Contains(IndexedModFixture.PluginName, response.RefusalReason, StringComparison.Ordinal);
        Assert.NotNull(SourceRepository.UnansweredExternalChange(_mod.ModFolder));
    }

    [Fact]
    public void KeepExternalChange_RefusalTravelsAsA200_NamingTheCollidingRecord()
    {
        var editService = MEditService.Tests.TestSupport.TestEditService.EditHandler(_mod.Holder);
        editService.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax",
            System.Text.Json.JsonDocument.Parse("0.5").RootElement);
        WriteExternalBinaryChange(0.9f);
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.KeepExternalChange(new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin),
            _mod.Holder, TestEditService.KeepHandler(), TestWatcher.Inert(), loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(result);
        var response = ok.Value;
        Assert.NotNull(response);
        Assert.False(response.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), response.RefusalReason, StringComparison.Ordinal);
    }

    [Fact]
    public void Rebase_UnknownOrigin_Returns404()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.Rebase(
            new RebaseRequest("NoSuchOrigin"), TestEditService.RebaseHandler(_mod.Holder), loggerFactory);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(404, problem.StatusCode);
    }

    [Fact]
    public void ContinueRebase_UnknownOrigin_Returns404()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.ContinueRebase(
            new RebaseRequest("NoSuchOrigin"), TestEditService.ContinueRebaseHandler(_mod.Holder), loggerFactory);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(404, problem.StatusCode);
    }

    [Fact]
    public void Rebase_CleanRepo_ReportsCleanOutcome()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.Rebase(
            new RebaseRequest(IndexedModFixture.ModFolderOrigin), TestEditService.RebaseHandler(_mod.Holder),
            loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<RebaseResponse>>(result);
        var response = ok.Value;
        Assert.NotNull(response);
        Assert.Equal(RebaseOutcome.Clean, response.Outcome);
    }
}
