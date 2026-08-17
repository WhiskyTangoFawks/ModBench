using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;

namespace MEditService.Tests.Edits;

/// <summary>
/// #371 AC3 guard paths at <see cref="EditOrchestrator"/>'s own public seam — narrower than the API
/// host (no HTTP, no real ledger repo), for the outcomes that don't depend on a real git commit
/// existing at all. The happy path (a real commit, reverted, re-applied through the normal save
/// path) is proven end to end, real git included, by
/// <c>MEditService.Tests.Api.RevertRecordLedgerApiTests</c>.
/// </summary>
public sealed class RevertRecordToLedgerCommitTests
{
    private static (EditOrchestrator orchestrator, SessionManager manager) MakeOrchestrator()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(
            manager, query, writer, changes, reflector, TestRecordVendor.Create(), TestRecordReverter.Create(),
            NullLogger<EditOrchestrator>.Instance);
        return (orchestrator, manager);
    }

    [Fact]
    public async Task RevertRecordToLedgerCommitAsync_NoSession_ReturnsNoSession()
    {
        var (orchestrator, manager) = MakeOrchestrator();
        using (manager)
        {
            var result = await orchestrator.RevertRecordToLedgerCommitAsync("000001:Test.esp", "Test.esp", "HEAD", "user");
            Assert.IsType<StageEditResult.NoSession>(result);
        }
    }

    // A DataDirectory-origin plugin (the flat single-folder fixture layout) has no distinct origin
    // folder to serve as a ledger working tree (#370 Q3) — the same "not a bug, a legal
    // truth-partition state" this ticket's own VendorOnFirstTouch shares, so revert must refuse the
    // same way rather than throw trying to resolve a ledger repo that structurally cannot exist.
    [Fact]
    public async Task RevertRecordToLedgerCommitAsync_DataDirectoryOriginPlugin_ReturnsRecordNotFound()
    {
        FormKey npcFk = default;
        using var data = new PluginFixtureBuilder("revert-guard")
            .WithPlugin("TestPlugin.esp", mod => npcFk = mod.Npcs.AddNew("PlainNpc").FormKey)
            .Build();

        var (orchestrator, manager) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            var result = await orchestrator.RevertRecordToLedgerCommitAsync(npcFk.ToString(), "TestPlugin.esp", "HEAD", "user");

            Assert.IsType<StageEditResult.RecordNotFound>(result);
        }
    }

    [Fact]
    public async Task RevertRecordToLedgerCommitAsync_UnknownFormKey_ReturnsRecordNotFound()
    {
        using var data = new PluginFixtureBuilder("revert-guard-unknown")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("PlainNpc"))
            .Build();

        var (orchestrator, manager) = MakeOrchestrator();
        using (manager)
        {
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            var result = await orchestrator.RevertRecordToLedgerCommitAsync("FFFFFF:TestPlugin.esp", "TestPlugin.esp", "HEAD", "user");

            Assert.IsType<StageEditResult.RecordNotFound>(result);
        }
    }
}
