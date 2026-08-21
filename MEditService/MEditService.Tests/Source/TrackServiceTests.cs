using System.Security.Cryptography;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

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
    public async Task TrackAsync_RealSession_WritesOneSourceFilePerRecord_AndTracksTheModFolder()
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

            using var manager = new SessionManager(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(
                gameDir,
                [new ExplicitPluginInput("Fixture.esp", pluginPath, "FixtureMod", true)],
                GameRelease.Fallout4);

            var service = new TrackService(SharedSchemaReflector.Instance, NullLogger<TrackService>.Instance);
            await service.TrackAsync(sessionManager.Session!, "FixtureMod", SourcePreset.Edits);

            Assert.True(SourceRepository.IsTracked(modFolder));

            var relativePath1 = SourceRecordPath.For("Fixture.esp", "npc_", npc1.FormKey.ToString());
            var relativePath2 = SourceRecordPath.For("Fixture.esp", "npc_", npc2.FormKey.ToString());
            var sourceFile1 = Path.Combine(modFolder, relativePath1);
            var sourceFile2 = Path.Combine(modFolder, relativePath2);
            Assert.True(File.Exists(sourceFile1), $"expected {sourceFile1}");
            Assert.True(File.Exists(sourceFile2), $"expected {sourceFile2}");

            var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
            var roundTripped = await codec.DeserializeAsync(sourceFile1, GameRelease.Fallout4);
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

    // #414 review finding F1: TrackProvenance.MetaSha256 was hardcoded null — the pinned
    // three-trailer set (Upstream-Version, Binary-SHA256, Meta-SHA256, ADR-0041 amendment) only
    // ever shipped two. meta.ini is a source, never tracked content, so this reads its raw bytes
    // (opaque, never interpreted) the same way ReadMetaIniVersion already does for Upstream-Version.
    [Fact]
    public async Task TrackAsync_WithAMetaIniBesideThePlugin_WritesItsSha256AsATrailer()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-meta-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-meta-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SomeNpc");
            mod.WriteToBinary(pluginPath);

            var metaBytes = "[General]\nversion=1.2.3\n"u8.ToArray();
            File.WriteAllBytes(Path.Combine(modFolder, "meta.ini"), metaBytes);
            var expectedHash = Convert.ToHexString(SHA256.HashData(metaBytes));

            using var manager = new SessionManager(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(
                gameDir,
                [new ExplicitPluginInput("Fixture.esp", pluginPath, "FixtureMod", true)],
                GameRelease.Fallout4);

            var service = new TrackService(SharedSchemaReflector.Instance, NullLogger<TrackService>.Instance);
            await service.TrackAsync(sessionManager.Session!, "FixtureMod", SourcePreset.Edits);

            var gitDir = Path.Combine(modFolder, ".git");
            var body = GitCli.Run(gitDir, modFolder, "log", "-1", "--format=%B", "main");
            Assert.Contains($"Meta-SHA256: {expectedHash}", body);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // Positive control's mirror: no meta.ini beside the plugin (an authored/manually-installed
    // mod, ADR-0041 amendment) means no Meta-SHA256 trailer at all — every TrackProvenance field
    // is optional, this must not fabricate one.
    [Fact]
    public async Task TrackAsync_WithNoMetaIni_WritesNoMetaSha256Trailer()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-nometa-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-nometa-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SomeNpc");
            mod.WriteToBinary(pluginPath);

            using var manager = new SessionManager(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(
                gameDir,
                [new ExplicitPluginInput("Fixture.esp", pluginPath, "FixtureMod", true)],
                GameRelease.Fallout4);

            var service = new TrackService(SharedSchemaReflector.Instance, NullLogger<TrackService>.Instance);
            await service.TrackAsync(sessionManager.Session!, "FixtureMod", SourcePreset.Edits);

            var gitDir = Path.Combine(modFolder, ".git");
            var body = GitCli.Run(gitDir, modFolder, "log", "-1", "--format=%B", "main");
            Assert.DoesNotContain("Meta-SHA256", body);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // #414 review finding F3: the already-tracked check must fire before the deep-parse/serialize
    // loop, not after — otherwise the 46-second worst case runs to completion (or, as here, blows
    // up on a corrupt file) before the caller ever learns the cheap, typed answer was available up
    // front. The plugin here loads fine into the session (so TrackAsync's own plugin-resolution
    // step succeeds) but is corrupted on disk afterward — never-assume-exclusive-ownership means
    // this is a legitimate state, not a test artifact — so TrackService's *own* deep parse of it
    // must fail if the loop is ever reached. Pre-tracking the mod folder first means the *correct*
    // outcome is SourceAlreadyTrackedException, thrown before that corrupt parse is attempted.
    [Fact]
    public async Task TrackAsync_OnAnAlreadyTrackedModFolder_RefusesBeforeParsingAnything()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-alreadytracked-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-alreadytracked-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SomeNpc");
            mod.WriteToBinary(pluginPath);

            using var manager = new SessionManager(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(
                gameDir,
                [new ExplicitPluginInput("Fixture.esp", pluginPath, "FixtureMod", true)],
                GameRelease.Fallout4);

            // Track the mod folder once, for real, before corrupting anything.
            SourceRepository.Track(
                modFolder, SourcePreset.Edits,
                [new PristineFile("Fixture.esp.source/npc_/Fixture.esp/000001.json", "{}"u8.ToArray())],
                new TrackProvenance(null, null, new Dictionary<string, string>()));

            // The session already parsed a good copy; the file on disk is corrupted afterward —
            // exactly the state TrackService's own fresh deep parse must fail against if it is
            // ever reached.
            File.WriteAllBytes(pluginPath, [0x00, 0x01, 0x02, 0x03]);

            var service = new TrackService(SharedSchemaReflector.Instance, NullLogger<TrackService>.Instance);
            await Assert.ThrowsAsync<SourceAlreadyTrackedException>(
                () => service.TrackAsync(sessionManager.Session!, "FixtureMod", SourcePreset.Edits));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // #414 review finding F2: "reports progress" — TrackService.Progress must genuinely advance
    // while a track is in flight, not just report Idle before and Idle-again-with-nothing-in-
    // between after. 400 records (real per-record temp-file serialize I/O, not an artificial
    // delay hook) gives a concurrent poll on the calling thread a real window to observe a
    // Serializing tick strictly between 0 and the total — TrackAsync's own first real `await`
    // (inside SerializeToPristineFileAsync) is what yields control back to this thread at all.
    [Fact]
    public async Task TrackAsync_ProgressAdvancesDuringATrack_ObservableMidFlight()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-progress-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-progress-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            for (var i = 0; i < 400; i++) mod.Npcs.AddNew($"Npc{i}");
            mod.WriteToBinary(pluginPath);

            using var manager = new SessionManager(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(
                gameDir,
                [new ExplicitPluginInput("Fixture.esp", pluginPath, "FixtureMod", true)],
                GameRelease.Fallout4);

            var service = new TrackService(SharedSchemaReflector.Instance, NullLogger<TrackService>.Instance);
            Assert.Equal(TrackPhase.Idle, service.Progress.Phase);

            var observed = new List<TrackProgress>();
            var trackTask = service.TrackAsync(sessionManager.Session!, "FixtureMod", SourcePreset.Edits);
            while (!trackTask.IsCompleted)
                observed.Add(service.Progress);
            await trackTask;

            Assert.Contains(observed, p => p.Phase == TrackPhase.Serializing && p.RecordsDone > 0 && p.RecordsDone < p.RecordsTotal);
            Assert.Equal(TrackPhase.Idle, service.Progress.Phase);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }
}
