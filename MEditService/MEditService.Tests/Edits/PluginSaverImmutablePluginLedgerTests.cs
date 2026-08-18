using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #371 AC2, correct driver (orchestrator-directed review finding, overriding an earlier reviewer
/// pass): "Save failure (validation refusal) leaves the ledger unadvanced" has to be proven by a
/// save that reaches a *real*, existing group and gets refused for a business reason —
/// <see cref="SaveGroupResult.ImmutablePlugin"/> — with real ledger dirt genuinely at risk, not an
/// unknown/already-consumed group id (a not-found that never enters the save pipeline at all —
/// <c>SaveChangeGroupLedgerCommitApiTests.SaveChangeGroup_UnknownGroupId_LeavesTheLedgerUnadvanced</c>
/// covers that case and stays; this one covers the case the criterion actually names).
///
/// <see cref="SaveGroupResult.ImmutablePlugin"/> is unreachable with real ledger dirt through the
/// HTTP API: <c>StageEdit</c>'s own guard (<c>ValidateEditContext</c>) already refuses staging onto
/// an immutable plugin before anything can vendor. So this bypasses <c>EditOrchestrator</c>/HTTP
/// the same way <c>PluginSaverSaveGroupTests</c>' own <c>Save_ImmutablePlugin_...</c> tests do
/// (<see cref="RecordVendor"/> + <c>StageChanges</c> called directly) — but with a *real*
/// <see cref="SessionManager"/> (so <c>IsImmutable</c> is the real classification an unlisted
/// plugin gets, not a stubbed one) and a *real* <see cref="LedgerRepository"/> (so the "ledger
/// unadvanced" assertion is against real git, not a throwaway one nothing ever reaches).
/// </summary>
public sealed class PluginSaverImmutablePluginLedgerTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    [Fact]
    public async Task Save_RefusedForImmutablePlugin_LeavesRealLedgerDirtUnadvanced()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-immutable-ledger-").FullName;
        Mutagen.Bethesda.Plugins.FormKey npcFk = default;
        using var data = new PluginFixtureBuilder("immutable-ledger")
            // listed: false — an unlisted Data-directory plugin loads as an implicit/immutable
            // listing (GameSession), the same mechanism ImmutablePluginFixture already uses.
            .WithPlugin("Fallout4.esm", mod => npcFk = mod.Npcs.AddNew("ImmutableNpc").FormKey, listed: false)
            .WithPlugin("User.esp", mod => mod.Npcs.AddNew("UserNpc"))
            .Build();
        var npcFormKey = npcFk.ToString();

        try
        {
            var reflector = SharedSchemaReflector.Instance;
            var repositoryFactory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
            using var manager = new SessionManager(repositoryFactory, writer);
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            var pluginMeta = manager.Session!.LoadOrderPlugin("Fallout4.esm")!;
            Assert.True(pluginMeta.IsImmutable); // the precondition this test is about

            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
            var recordVendor = new RecordVendor(ledger, codec, NullLogger<RecordVendor>.Instance);
            var schemas = reflector.GetSchemas(GameRelease.Fallout4);

            // Real ledger dirt — bypassing StageEdit's own immutable guard directly, the way this
            // file's own class remarks describe.
            await recordVendor.VendorAndStageDirtAsync(
                data.DataFolder, pluginMeta.Path, "Fallout4.esm", "npc_", typeof(Npc), npcFormKey,
                new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
                schemas, GameRelease.Fallout4);

            var (gitDir, workTree) = ledger.PathsFor(data.DataFolder);
            var beforeLog = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
            var beforeStatus = GitCli.Run(gitDir, workTree, "status", "--porcelain");
            Assert.NotEmpty(beforeLog); // sanity: real dirt genuinely exists, something is at risk

            var changes = DuckDbTestFactory.MakePendingChangeService();
            var group = changes.StageChanges([
                new GroupMember(
                    npcFormKey, "Fallout4.esm", "npc_", PendingChangeConstants.FieldEditChangeType,
                    "aggression", J("\"Unaggressive\""), J("\"Frenzied\""), "user",
                    ParentCell: null, PlacementGroup: null, Origin: PluginOrigin.DataDirectory),
            ]);

            var ledgerCommitter = new LedgerGroupCommitter(ledger, NullLogger<LedgerGroupCommitter>.Instance);
            var saver = new PluginSaver(changes, manager, ledgerCommitter, NullLogger<PluginSaver>.Instance);

            var result = await saver.Save(group.Id);

            var immutable = Assert.IsType<SaveGroupResult.ImmutablePlugin>(result);
            Assert.Equal("Fallout4.esm", immutable.Plugin);

            // AC2: the save that *started* against real content and then refused left the real
            // ledger repo byte-for-byte unchanged.
            var afterLog = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
            var afterStatus = GitCli.Run(gitDir, workTree, "status", "--porcelain");
            Assert.Equal(beforeLog, afterLog);
            Assert.Equal(beforeStatus, afterStatus);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
        }
    }
}
