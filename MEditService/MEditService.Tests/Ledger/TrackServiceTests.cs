using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #414's orchestration seam end to end: a real loaded session, a real (small) plugin with real
/// records, tracked through <see cref="TrackService"/> — the first production caller of
/// <see cref="RecordTextCodec"/> (its own doc comment: "zero production callers" until this
/// ticket). Deliberately a small synthetic fixture, not the mega-plugin — mega-scale timing is a
/// measured, reported number, not a suite-gating assertion.
/// </summary>
public sealed class TrackServiceTests
{
    [Fact]
    public async Task TrackAsync_RealSession_WritesOneLedgerFilePerRecord_AndTracksTheModFolder()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            var npc1 = mod.Npcs.AddNew("FirstNpc");
            var npc2 = mod.Npcs.AddNew("SecondNpc");
            mod.WriteToBinary(pluginPath);

            using var manager = new SessionManager(new DuckDbRecordRepositoryFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(
                gameDir,
                [new ExplicitPluginInput("Fixture.esp", pluginPath, "FixtureMod", true)],
                GameRelease.Fallout4);

            var service = new TrackService(SharedSchemaReflector.Instance, NullLogger<TrackService>.Instance);
            await service.TrackAsync(sessionManager.Session!, "FixtureMod", LedgerPreset.Edits);

            Assert.True(LedgerRepository.IsTracked(modFolder));

            var relativePath1 = LedgerRecordPath.For("Fixture.esp", "npc_", npc1.FormKey.ToString());
            var relativePath2 = LedgerRecordPath.For("Fixture.esp", "npc_", npc2.FormKey.ToString());
            var ledgerFile1 = Path.Combine(modFolder, relativePath1);
            var ledgerFile2 = Path.Combine(modFolder, relativePath2);
            Assert.True(File.Exists(ledgerFile1), $"expected {ledgerFile1}");
            Assert.True(File.Exists(ledgerFile2), $"expected {ledgerFile2}");

            var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
            var roundTripped = await codec.DeserializeAsync(ledgerFile1, typeof(Npc), GameRelease.Fallout4);
            Assert.Equal(npc1.FormKey, roundTripped.FormKey);

            var gitDir = Path.Combine(modFolder, ".git");
            var body = GitCli.Run(gitDir, modFolder, "log", "-1", "--format=%B", "main");
            Assert.Contains($"Binary-SHA256: Fixture.esp=", body);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }
}
