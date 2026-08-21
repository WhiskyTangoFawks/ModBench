using System.Security.Cryptography;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Serialization.Newtonsoft;

namespace MEditService.Tests.Source;

/// <summary>
/// #414's orchestration seam end to end: a real loaded session, a real (small) plugin with real
/// records, tracked through <see cref="TrackService"/>. #451 slice A rewrote Track's own write path
/// to serialize through the whole-mod door (<see cref="Serialization.RecordTextCodecGeneratorSeed.SerializeWholeMod"/>)
/// instead of the per-record codec, so these assertions now check the Spriggit layout — group folders,
/// root <c>RecordData.json</c>, sidecars — rather than the pre-#451 flat
/// <c>&lt;recordType&gt;/&lt;originModKey&gt;/&lt;hex6&gt;.json</c> shape. Deliberately a small synthetic
/// fixture, not the mega-plugin — mega-scale timing is a measured, reported number, not a
/// suite-gating assertion.
/// </summary>
public sealed class TrackServiceTests
{
    [Fact]
    public async Task TrackAsync_RealSession_WritesTheSpriggitTree_AndTracksTheModFolder()
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

            var service = new TrackService(NullLogger<TrackService>.Instance);
            await service.TrackAsync(sessionManager.Session!, "FixtureMod", SourcePreset.Edits);

            Assert.True(SourceRepository.IsTracked(modFolder));

            // AC1: key paths from the spike doc's own layout sketch — root header, and each flat NPC
            // under its own group folder.
            var sourceRoot = Path.Combine(modFolder, "Fixture.esp.source");
            var rootHeader = Path.Combine(sourceRoot, "RecordData.json");
            Assert.True(File.Exists(rootHeader), $"expected {rootHeader}");

            var relativePath1 = SourceRecordPath.For("Fixture.esp", "npc_", npc1.FormKey.ToString(), "FirstNpc", GameRelease.Fallout4);
            var relativePath2 = SourceRecordPath.For("Fixture.esp", "npc_", npc2.FormKey.ToString(), "SecondNpc", GameRelease.Fallout4);
            var sourceFile1 = Path.Combine(modFolder, relativePath1);
            var sourceFile2 = Path.Combine(modFolder, relativePath2);
            Assert.True(File.Exists(sourceFile1), $"expected {sourceFile1}");
            Assert.True(File.Exists(sourceFile2), $"expected {sourceFile2}");

            var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
            var roundTripped = await codec.DeserializeAsync(sourceFile1, GameRelease.Fallout4, "npc_");
            Assert.Equal(npc1.FormKey, roundTripped.FormKey);

            // AC2: both sidecars present, and the root document carries SpriggitSource, positioned
            // and shaped exactly as the generator's own extraMeta hook would have written it (#451
            // review, finding 3 — key placement and Newtonsoft-vs-System.Text.Json formatting drift).
            Assert.True(File.Exists(Path.Combine(sourceRoot, ".spriggit")));
            Assert.True(File.Exists(Path.Combine(sourceRoot, "spriggit-meta.json")));
            var rootText = await File.ReadAllTextAsync(rootHeader);
            Assert.Contains($"\"PackageName\": \"{SpriggitSource.CurrentPackageName}\"", rootText, StringComparison.Ordinal);
            var firstKey = rootText.IndexOf('"', rootText.IndexOf('{') + 1);
            Assert.StartsWith("\"SpriggitSource\"", rootText[firstKey..], StringComparison.Ordinal);

            // AC2, made real (#451 review, finding 6): a string-contains check passes on JSON the
            // real deserializer can't read at all — round-trip the root document through the
            // whole-mod door's own Deserialize, the same generated mixin Serialize went through, and
            // confirm the two NPCs it wrote come back out. This is Tests-side, not Core (AC2's own
            // guard scans Core's sources only — DocumentShapeParityTests already established this is
            // exactly how the two doors are meant to be checked against each other). No extraMeta
            // argument: the generated Deserialize's own extraMeta parameter hits the identical
            // overload-collision defect Serialize's does (RecordTextCodecGeneratorSeed's own doc
            // comment) — this proves the tree (SpriggitSource splice included) is genuinely valid,
            // parseable Spriggit-shape JSON, which is AC2's actual claim.
            var deserializedMod = await MutagenJsonConverter.Instance.Deserialize(sourceRoot);
            Assert.Equal(2, deserializedMod.Npcs.Count);
            Assert.Contains(deserializedMod.Npcs, n => n.FormKey == npc1.FormKey && n.EditorID == "FirstNpc");
            Assert.Contains(deserializedMod.Npcs, n => n.FormKey == npc2.FormKey && n.EditorID == "SecondNpc");

            // AC4: no \r anywhere in the tracked tree.
            foreach (var file in Directory.EnumerateFiles(sourceRoot, "*", SearchOption.AllDirectories))
                Assert.DoesNotContain((byte)'\r', await File.ReadAllBytesAsync(file));

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

            var service = new TrackService(NullLogger<TrackService>.Instance);
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

            var service = new TrackService(NullLogger<TrackService>.Instance);
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

            // Track the mod folder once, for real, before corrupting anything — a Spriggit-flat-shaped
            // dummy path (#451), matching what TrackAsync would actually have written, though the
            // content doesn't matter for this test: only IsTracked's answer does.
            SourceRepository.Track(
                modFolder, SourcePreset.Edits,
                [new PristineFile("Fixture.esp.source/Npcs/000001_Fixture.esp.json", "{}"u8.ToArray())],
                new TrackProvenance(null, null, new Dictionary<string, string>()));

            // The session already parsed a good copy; the file on disk is corrupted afterward —
            // exactly the state TrackService's own fresh deep parse must fail against if it is
            // ever reached.
            File.WriteAllBytes(pluginPath, [0x00, 0x01, 0x02, 0x03]);

            var service = new TrackService(NullLogger<TrackService>.Instance);
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
    // between after. #451 slice A coarsened Serializing's own granularity from per-record to
    // per-plugin (TrackProgress.cs's own doc comment: the whole-mod door serializes a whole plugin in
    // one call, with no per-record progress callback to observe) — so a genuine 0 < done < total tick
    // now needs *two plugins* under one origin, not one plugin with many records: the mid-flight
    // observation point is between the first plugin's whole-mod door call finishing and the second's
    // starting, which TrackAsync's own SetProgress(Serializing, parsedDone - 1, plugins.Count) call
    // (right before the second plugin's await) makes real, given a second plugin large enough to hold
    // that window open for a concurrent poll to land in.
    [Fact]
    public async Task TrackAsync_ProgressAdvancesDuringATrack_ObservableMidFlight()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-progress-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-progress-game-").FullName;
        try
        {
            var firstPluginPath = Path.Combine(modFolder, "First.esp");
            var firstMod = new Fallout4Mod(ModKey.FromFileName("First.esp"), Fallout4Release.Fallout4);
            firstMod.Npcs.AddNew("OnlyNpc");
            firstMod.WriteToBinary(firstPluginPath);

            var secondPluginPath = Path.Combine(modFolder, "Second.esp");
            var secondMod = new Fallout4Mod(ModKey.FromFileName("Second.esp"), Fallout4Release.Fallout4);
            for (var i = 0; i < 400; i++) secondMod.Npcs.AddNew($"Npc{i}");
            secondMod.WriteToBinary(secondPluginPath);

            using var manager = new SessionManager(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(
                gameDir,
                [
                    new ExplicitPluginInput("First.esp", firstPluginPath, "FixtureMod", true),
                    new ExplicitPluginInput("Second.esp", secondPluginPath, "FixtureMod", true),
                ],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);
            Assert.Equal(TrackPhase.Idle, service.Progress.Phase);

            var observed = new List<TrackProgress>();
            var trackTask = service.TrackAsync(sessionManager.Session!, "FixtureMod", SourcePreset.Edits);
            while (!trackTask.IsCompleted)
                observed.Add(service.Progress);
            await trackTask;

            Assert.Contains(observed, p => p.Phase == TrackPhase.Serializing && p.PluginsDone > 0 && p.PluginsDone < p.PluginsTotal);
            Assert.Equal(TrackPhase.Idle, service.Progress.Phase);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }
}
