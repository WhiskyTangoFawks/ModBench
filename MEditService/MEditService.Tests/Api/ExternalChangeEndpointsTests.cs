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
    public void AbsorbExternalChange_AbsorbsAndClearsTheUnansweredQuestion()
    {
        WriteExternalBinaryChange(0.9f);
        var watcher = new ModFolderWatcher();
        watcher.ReportExternalChange(_mod.ModFolder,
            new ExternalChangeClassification.ExternalChange([IndexedModFixture.PluginName], [], false, null, null));
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.AbsorbExternalChange(new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin),
            _mod.Index, TestEditService.AbsorbHandler(), watcher, loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(result);
        Assert.True(ok.Value!.Succeeded);
        Assert.Empty(watcher.Unanswered());
    }

    [Fact]
    public void AbsorbExternalChange_UnknownOrigin_Returns503()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.AbsorbExternalChange(new ExternalChangeActionRequest("NoSuchOrigin"),
            _mod.Index, TestEditService.AbsorbHandler(), new ModFolderWatcher(), loggerFactory);

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
        var watcher = new ModFolderWatcher();
        watcher.ReportExternalChange(_mod.ModFolder,
            new ExternalChangeClassification.ExternalChange([IndexedModFixture.PluginName], [], false, null, null));
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.AbsorbExternalChange(new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin),
            _mod.Index, TestEditService.AbsorbHandler(), watcher, loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(result);
        Assert.False(ok.Value!.Succeeded);
        Assert.Contains(IndexedModFixture.PluginName, ok.Value.RefusalReason, StringComparison.Ordinal);
        Assert.NotEmpty(watcher.Unanswered());
    }

    [Fact]
    public void KeepExternalChange_RefusalTravelsAsA200_NamingTheCollidingRecord()
    {
        var editService = MEditService.Tests.TestSupport.TestEditService.EditHandler(_mod.Index);
        editService.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax",
            System.Text.Json.JsonDocument.Parse("0.5").RootElement);
        WriteExternalBinaryChange(0.9f);
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.KeepExternalChange(new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin),
            _mod.Index, TestEditService.KeepHandler(), new ModFolderWatcher(), loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(result);
        Assert.False(ok.Value!.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), ok.Value.RefusalReason, StringComparison.Ordinal);
    }

    [Fact]
    public void Rebase_UnknownOrigin_Returns404()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.Rebase(
            new RebaseRequest("NoSuchOrigin"), TestEditService.RebaseHandler(_mod.Index), loggerFactory);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(404, problem.StatusCode);
    }

    [Fact]
    public void ContinueRebase_UnknownOrigin_Returns404()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.ContinueRebase(
            new RebaseRequest("NoSuchOrigin"), TestEditService.ContinueRebaseHandler(_mod.Index), loggerFactory);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(404, problem.StatusCode);
    }

    [Fact]
    public void Rebase_CleanRepo_ReportsCleanOutcome()
    {
        var (loggerFactory, _) = CapturingLoggerFactory();
        using var _disposeLogger = loggerFactory;

        var result = PluginEndpoints.Rebase(
            new RebaseRequest(IndexedModFixture.ModFolderOrigin), TestEditService.RebaseHandler(_mod.Index),
            loggerFactory);

        var ok = Assert.IsAssignableFrom<Ok<RebaseResponse>>(result);
        Assert.Equal(RebaseOutcome.Clean, ok.Value!.Outcome);
    }
}
