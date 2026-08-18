using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
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

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    // #371 review (mutation axis + spec reviewer): "a field changing from null" — the current
    // (committed) state is null, the historical (ledger) state is a real value, revert must stage
    // that historical value back. Every top-level scalar FormLink column on NPC_ is read-only
    // (probed directly: 29 of 29 nullable ones), and ApplyListJson no-ops on a JSON null for array
    // columns — so a committed *array* field can never legitimately reach null through the normal
    // save path at all; this manipulates the committed index directly (never git, never the ledger)
    // to reach that state, rather than pretending an unreachable write happened through PluginWriter.
    [Fact]
    public async Task RevertRecordToLedgerCommitAsync_FieldChangingFromNull_StagesTheHistoricalValue()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-revert-fromnull-ledger-").FullName;
        FormKey npcFk = default, kwFk = default;
        using var data = new PluginFixtureBuilder("revert-fromnull")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var kw = mod.Keywords.AddNew();
                kwFk = kw.FormKey;
                var npc = mod.Npcs.AddNew("RevertNpc");
                npc.Keywords = [new FormLink<IKeywordGetter>(kw.FormKey)]; // pristine non-null
                npcFk = npc.FormKey;
            })
            .Build();
        var npcFormKey = npcFk.ToString();

        try
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            var changes = DuckDbTestFactory.MakePendingChangeService();
            var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
            var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);

            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
            var recordVendor = new RecordVendor(ledger, codec, NullLogger<RecordVendor>.Instance);
            var recordReverter = new RecordReverter(ledger, codec, new LedgerRecordFieldReader(factory));

            var orchestrator = new EditOrchestrator(
                manager, query, writer, changes, reflector, recordVendor, recordReverter, NullLogger<EditOrchestrator>.Instance);

            var pluginMeta = manager.Session!.LoadOrderPlugin("TestPlugin.esp")!;
            var schemas = reflector.GetSchemas(GameRelease.Fallout4);

            // Commit A: vendors the pristine record (keywords = [kwFk]) — an unrelated field
            // triggers it; the vendor baseline still captures every field's pristine value.
            await recordVendor.VendorAndStageDirtAsync(
                data.DataFolder, pluginMeta.Path, "TestPlugin.esp", "npc_", typeof(Npc), npcFormKey,
                new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
                schemas, GameRelease.Fallout4);
            var (gitDir, workTree) = ledger.PathsFor(data.DataFolder);
            var commitA = GitCli.Run(gitDir, workTree, "log", "-1", "--format=%H", "main").Trim();

            // Current (committed index): keywords forced to null directly.
            var repo = (IRecordRepository)manager.Repository!;
            using (var cmd = repo.Connection.CreateCommand())
            {
                cmd.CommandText = "UPDATE \"npc_\" SET keywords = NULL WHERE form_key = $1";
                cmd.Parameters.Add(new DuckDBParameter { Value = npcFormKey });
                cmd.ExecuteNonQuery();
            }

            var revertResult = await orchestrator.RevertRecordToLedgerCommitAsync(npcFormKey, "TestPlugin.esp", commitA, "user");

            var staged = Assert.IsType<StageEditResult.Staged>(revertResult);
            var change = Assert.Single(staged.Changes, c => c.FieldPath == "keywords");
            Assert.Equal(kwFk.ToString(), Assert.Single(change.NewValue.EnumerateArray()).GetString());
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
        }
    }
}
