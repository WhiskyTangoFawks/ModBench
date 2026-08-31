using System.Security.Cryptography;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Serialization.Newtonsoft;
using Mutagen.Bethesda.Strings;
using Noggog.WorkEngine;

namespace MEditService.Tests.Source;

/// <summary>
/// The Track orchestration seam end to end: a real loaded load order, a real (small) plugin with
/// real records, tracked through <see cref="TrackService"/>. Track serializes through the whole-mod
/// door (<see cref="Serialization.RecordTextCodecGeneratorSeed.SerializeWholeMod"/>), so these
/// assertions check the source layout — group folders, root <c>RecordData.json</c>. Deliberately a
/// small synthetic fixture, not the mega-plugin — mega-scale timing is a measured, reported number,
/// not a suite-gating assertion.
/// </summary>
public sealed class TrackServiceTests
{
    [Fact]
    public async Task TrackAsync_RealLoadOrder_WritesTheSourceTree_AndTracksTheModFolder()
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

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);
            await service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits);

            Assert.True(SourceRepository.IsTracked(modFolder));

            // Key layout paths: root header, and each flat NPC under its own group folder.
            var sourceRoot = Path.Combine(modFolder, SourceRecordPath.RootFor("Fixture.esp"));
            var rootHeader = Path.Combine(sourceRoot, "RecordData.json");
            Assert.True(File.Exists(rootHeader), $"expected {rootHeader}");

            // SourceRecordPath.For alone cannot name the file without knowing its order index —
            // resolved through SourceUnitResolver instead, which finds it by FormKey suffix
            // regardless of position.
            var sourceFile1 = SourceUnitResolver.FlatSourcePath(
                modFolder, "Fixture.esp", "npc_", npc1.FormKey.ToString(), "FirstNpc", GameRelease.Fallout4);
            var sourceFile2 = SourceUnitResolver.FlatSourcePath(
                modFolder, "Fixture.esp", "npc_", npc2.FormKey.ToString(), "SecondNpc", GameRelease.Fallout4);
            Assert.True(File.Exists(sourceFile1), $"expected {sourceFile1}");
            Assert.True(File.Exists(sourceFile2), $"expected {sourceFile2}");

            var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
            var roundTripped = await codec.DeserializeAsync(sourceFile1, GameRelease.Fallout4, "npc_");
            Assert.Equal(npc1.FormKey, roundTripped.FormKey);

            // Spriggit has no role in v1 (ADR-0042) — the root document holds the mod
            // header's own fields only, no package stamp, and Track writes no sidecar beside the
            // tree.
            Assert.False(File.Exists(Path.Combine(sourceRoot, ".spriggit")));
            Assert.False(File.Exists(Path.Combine(sourceRoot, "spriggit-meta.json")));
            var rootText = await File.ReadAllTextAsync(rootHeader);
            Assert.DoesNotContain("SpriggitSource", rootText, StringComparison.Ordinal);

            // The root document is still genuinely valid, parseable JSON the whole-mod door's own
            // Deserialize can read back — round-trip it through the same generated mixin Serialize
            // went through and confirm the two NPCs it wrote come back out. No extraMeta argument:
            // the generated Deserialize's own extraMeta parameter hits the overload-collision defect
            // Serialize's does (RecordTextCodecGeneratorSeed's own doc comment).
            var deserializedMod = await MutagenJsonConverter.Instance.Deserialize(sourceRoot);
            Assert.Equal(2, deserializedMod.Npcs.Count);
            Assert.Contains(deserializedMod.Npcs, n => n.FormKey == npc1.FormKey && n.EditorID == "FirstNpc");
            Assert.Contains(deserializedMod.Npcs, n => n.FormKey == npc2.FormKey && n.EditorID == "SecondNpc");

            // No \r anywhere in the tracked tree.
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

    // The pinned trailer set (Upstream-Version, Binary-SHA256, Meta-SHA256 — ADR-0041 amendment)
    // must ship all three. meta.ini is a source, never tracked content, so its raw bytes are hashed
    // (opaque, never interpreted) the same way ReadMetaIniVersion already reads Upstream-Version.
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

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);
            await service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits);

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

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);
            await service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits);

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

    // The already-tracked check must fire before the deep-parse/serialize loop, not after —
    // otherwise the 46-second worst case runs to completion (or, as here, blows up on a corrupt
    // file) before the caller ever learns the cheap, typed answer was available up front.
    // The plugin here loads fine into the load order (so TrackAsync's own plugin-resolution
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

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            // Track the mod folder once, for real, before corrupting anything — a dummy path shaped
            // like what TrackAsync would actually have written, though the content doesn't matter
            // for this test: only IsTracked's answer does.
            SourceRepository.Track(
                modFolder, SourcePreset.Edits,
                [new PristineFile("source/Fixture.esp/Npcs/000001_Fixture.esp.json", "{}"u8.ToArray())],
                new TrackProvenance(null, null, new Dictionary<string, string>()));

            // The load order already parsed a good copy; the file on disk is corrupted afterward —
            // exactly the state TrackService's own fresh deep parse must fail against if it is
            // ever reached.
            File.WriteAllBytes(pluginPath, [0x00, 0x01, 0x02, 0x03]);

            var service = new TrackService(NullLogger<TrackService>.Instance);
            await Assert.ThrowsAsync<SourceAlreadyTrackedException>(
                () => service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // TrackService.Progress must genuinely advance while a track is in flight, not just report Idle
    // before and Idle-again-with-nothing-in-between after. Serializing's granularity is per-plugin
    // (TrackProgress.cs's own doc comment: the whole-mod door serializes a whole plugin in one call,
    // with no per-record progress callback to observe) — so a genuine 0 < done < total tick needs
    // *two plugins* under one origin, not one plugin with many records: the mid-flight observation
    // point is between the first plugin's whole-mod door call finishing and the second's starting,
    // which TrackAsync's SetProgress(Serializing, parsedDone - 1, plugins.Count) call (right before
    // the second plugin's await) makes real, given a second plugin large enough to hold that window
    // open for a concurrent poll to land in.
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

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [
                    new LoadOrderEntry("First.esp", firstPluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true),
                    new LoadOrderEntry("Second.esp", secondPluginPath, "FixtureMod", Slot: 1, Enabled: true, Winning: true),
                ],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);
            Assert.Equal(TrackPhase.Idle, service.Progress.Phase);

            var observed = new List<TrackProgress>();
            var trackTask = service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits);
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

    // ADR-0042 decision 2: "the gate runs ... at Track, over every record of the plugin being
    // tracked". The public TrackAsync overload always passes null for the round-trip gate's own
    // deserialize step, so it always uses the real whole-mod door — this test observes that it
    // genuinely happens (not merely that Track happens to succeed, which a gate that never actually
    // ran would also produce) by substituting a wrapper that still deserializes for real but also
    // counts its own calls, through the internal overload that exists for exactly this.
    [Fact]
    public async Task TrackAsync_RealLoadOrder_RunsTheRoundTripGateForRealBeforeSucceeding()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-gateran-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-gateran-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SomeNpc");
            mod.WriteToBinary(pluginPath);

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);

            var deserializeCalls = 0;
            Task<IFallout4Mod> CountingDeserialize(string folder, CancellationToken ct)
            {
                deserializeCalls++;
                return RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
            }

            await service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits, CountingDeserialize);

            Assert.Equal(1, deserializeCalls);
            Assert.True(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // ADR-0042 decision 2: "a plugin that does not round-trip is refused, with the failing
    // record named". No known codec defect is reproducible at this project's current Mutagen/
    // Serialization pins (TrackService's own doc comment on the internal overload), so this forges
    // one: a genuine deserialize of the tree Track just wrote, immediately mutated so what comes
    // back no longer matches what was serialized — indistinguishable, from the gate's own point of
    // view, from a real codec regression that silently changed one field on read. Kills the rival:
    // a TrackAsync that runs the gate but discards its result (or a stubbed-always-pass check)
    // makes this test fail to throw — verified by hand against a short-circuited VerifyRoundTrip.
    [Fact]
    public async Task TrackAsync_WithARecordThatFailsToRoundTrip_RefusesAndCommitsNothing()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-badroundtrip-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-badroundtrip-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            var npc = mod.Npcs.AddNew("OriginalName");
            mod.WriteToBinary(pluginPath);

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);

            static async Task<IFallout4Mod> DeserializeThenCorruptTheNpc(string folder, CancellationToken ct)
            {
                var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
                deserialized.Npcs.First().EditorID += "Corrupted";
                return deserialized;
            }

            var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(
                () => service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits, DeserializeThenCorruptTheNpc));

            Assert.Contains(npc.FormKey.ToString(), ex.Message);
            Assert.Contains("OriginalName", ex.Message);
            Assert.False(SourceRepository.IsTracked(modFolder));
            Assert.False(Directory.Exists(Path.Combine(modFolder, ".git")));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // Track refuses on *any* content difference — a mutated float field, not just a string field
    // like the sibling test above — with record type, FormKey and field name in the message.
    // HeightMin is set to a non-default value first so "the mutation changed it" is unambiguous.
    [Fact]
    public async Task TrackAsync_WithAFloatFieldThatFailsToRoundTrip_RefusesNamingTheRecordAndTheField()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-floatroundtrip-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-floatroundtrip-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            var npc = mod.Npcs.AddNew("SomeNpc");
            npc.HeightMin = 1.5f;
            mod.WriteToBinary(pluginPath);

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);

            static async Task<IFallout4Mod> DeserializeThenMutateTheFloat(string folder, CancellationToken ct)
            {
                var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
                deserialized.Npcs.First().HeightMin += 1.0f;
                return deserialized;
            }

            var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(
                () => service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits, DeserializeThenMutateTheFloat));

            Assert.Contains(npc.FormKey.ToString(), ex.Message);
            Assert.Contains("Npc", ex.Message);
            Assert.Contains("HeightMin", ex.Message);
            Assert.False(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // Real plugins (ScopeOverlayDOF.esp) carry opaque TES4 header subrecords like INTV, and
    // Mutagen.Bethesda.Serialization's generated Fallout4ModHeader_Serialization codec must carry
    // them faithfully through the tracked-source round trip. Permanent regression fixture: a minimal
    // synthetic header carrying the opaque-field shape every ModelIdentity.OpaqueHeaderFields member
    // exercises, plus TransientTypes (set, matching, despite not being allow-listed — see that
    // field's own known-gap tests in ModelIdentityTests). Not vacuous: nulling
    // recompiled.ModHeader.INTV inside a forged deserializer makes this throw a
    // SourceRoundTripFailedException naming "TES4 header field 'INTV'" — it genuinely distinguishes
    // the correct codec from a corrupting one.
    [Fact]
    public async Task TrackAsync_WithOpaqueHeaderFieldsSet_TracksSuccessfully()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-opaqueheader-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-opaqueheader-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SomeNpc");
            mod.ModHeader.INTV = new byte[] { 1, 0, 0, 0 };
            mod.ModHeader.INCC = 42;
            mod.ModHeader.TypeOffsets = new byte[] { 9, 8, 7 };
            mod.ModHeader.Deleted = new byte[] { 1, 2, 3 };
            mod.ModHeader.Screenshot = new byte[] { 4, 5, 6 };
            mod.ModHeader.Author = "Some Author";
            mod.ModHeader.Description = "Some Description";
            mod.ModHeader.TransientTypes.Add(new TransientType { FormType = 7 });
            mod.WriteToBinary(pluginPath);

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);

            await service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits);

            Assert.True(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // An allow-list entry with no end-to-end test that corrupts that field alone and asserts the
    // real refusal message names it is a claim nobody can cash — the vacuity that let a dead
    // TransientTypes entry sit on the list undetected. One case per
    // ModelIdentity.OpaqueHeaderFields member, run through the real TrackService.TrackAsync pipeline
    // (not just ModelIdentity.FindFirstHeaderFieldDivergence directly, which ModelIdentityTests' own
    // theory already covers) so the assertion is against the actual SourceRoundTripFailedException
    // message a caller would see.
    public static IEnumerable<object[]> AllowListedHeaderFieldCorruptions()
    {
        yield return new object[] { "TypeOffsets", Setter(h => h.TypeOffsets = new byte[] { 1, 2, 3 }), Setter(h => h.TypeOffsets = new byte[] { 9, 9, 9 }) };
        yield return new object[] { "Deleted", Setter(h => h.Deleted = new byte[] { 1, 2, 3 }), Setter(h => h.Deleted = new byte[] { 9, 9, 9 }) };
        yield return new object[] { "Screenshot", Setter(h => h.Screenshot = new byte[] { 1, 2, 3 }), Setter(h => h.Screenshot = new byte[] { 9, 9, 9 }) };
        yield return new object[] { "INTV", Setter(h => h.INTV = new byte[] { 1, 0, 0, 0 }), Setter(h => h.INTV = new byte[] { 99, 0, 0, 0 }) };
        yield return new object[] { "INCC", Setter(h => h.INCC = 1), Setter(h => h.INCC = 2) };
        yield return new object[] { "Author", Setter(h => h.Author = "Original"), Setter(h => h.Author = "Corrupted") };
        yield return new object[] { "Description", Setter(h => h.Description = "Original"), Setter(h => h.Description = "Corrupted") };

        static Action<Fallout4ModHeader> Setter(Action<Fallout4ModHeader> action) => action;
    }

    [Theory]
    [MemberData(nameof(AllowListedHeaderFieldCorruptions))]
    public async Task TrackAsync_ForEveryAllowListedHeaderField_RefusesNamingItWhenCorruptedAlone(
        string fieldName, Action<Fallout4ModHeader> setBaseline, Action<Fallout4ModHeader> corrupt)
    {
        var modFolder = Directory.CreateTempSubdirectory($"medit-trackservice-header-{fieldName}-").FullName;
        var gameDir = Directory.CreateTempSubdirectory($"medit-trackservice-header-{fieldName}-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SomeNpc");
            setBaseline(mod.ModHeader);
            mod.WriteToBinary(pluginPath);

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);

            async Task<IFallout4Mod> DeserializeThenCorrupt(string folder, CancellationToken ct)
            {
                var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
                corrupt(deserialized.ModHeader);
                return deserialized;
            }

            var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(
                () => service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits, DeserializeThenCorrupt));

            Assert.Contains($"TES4 header field '{fieldName}'", ex.Message);
            Assert.False(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // A rewrite that only *adds* subrecords must not be refused by the subrecord-inventory check
    // specifically. Mutagen's own Furniture writer
    // (FurnitureBinaryWriteTranslation.WriteBinaryFlagsCustom/WriteBinaryFlags2Custom, verified by
    // reading it) unconditionally emits FNAM/MNAM on every write regardless of whether the source it
    // read ever had them — Mutagen can never itself *author* a FURN missing them, so the "original"
    // here is hand-stripped from a real Mutagen-written one (the CK/community-tool shape observed in
    // the wild for FURN), not built through the object API.
    //
    // This is *not* an encoding-only difference: `Furniture.Flags` is a nullable property backed by
    // FNAM/MNAM — null when they're absent (the hand-stripped original), a real value once Mutagen's
    // writer re-adds them. That is a genuine content change, and the model-identity gate is right to
    // refuse it: it reparses what was actually written and names the real cause (Flags), never the
    // subrecord-inventory check.
    [Fact]
    public async Task TrackAsync_WithARecordThatOnlyGainsSubrecordsOnRewrite_RefusesNamingTheRealFieldNotSubrecordInventory()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-furn-insert-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-furn-insert-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            mod.Furniture.AddNew("TestFurn");
            mod.WriteToBinary(pluginPath);
            await File.WriteAllBytesAsync(pluginPath, StripFnamAndMnamFromTheOnlyFurnRecord(await File.ReadAllBytesAsync(pluginPath)));

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);
            var ex = await Assert.ThrowsAsync<SourceRoundTripFailedException>(
                () => service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits));

            Assert.DoesNotContain("is missing", ex.Message);
            Assert.DoesNotContain("FNAM", ex.Message);
            Assert.DoesNotContain("MNAM", ex.Message);
            Assert.Contains("Furniture", ex.Message);
            Assert.Contains("Flags", ex.Message);
            Assert.False(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    /// <summary>Removes the <c>FNAM</c>/<c>MNAM</c> subrecords Mutagen's own write unconditionally adds
    /// to a <c>FURN</c> record, fixing up the record's own declared size and its enclosing GRUP's
    /// declared size to match — producing a still-valid, still-parseable plugin that genuinely lacks
    /// them, the shape a rewrite then adds back.</summary>
    private static byte[] StripFnamAndMnamFromTheOnlyFurnRecord(byte[] original)
    {
        var records = PluginBinaryWalk.WalkRecords(original);
        var furnIndex = records.FindIndex(r => r.Type == "FURN");
        var furn = records[furnIndex];
        var grup = records[furnIndex - 1];

        var furnData = original.AsSpan(furn.DataStart, furn.DataLen).ToArray();
        var toRemove = PluginBinaryWalk.WalkSubrecords(furnData)
            .Where(s => s.Sig is "FNAM" or "MNAM")
            .OrderByDescending(s => s.Start)
            .ToList();
        var newFurnData = furnData.ToList();
        var removedBytes = 0;
        foreach (var s in toRemove)
        {
            newFurnData.RemoveRange(s.Start, s.Len);
            removedBytes += s.Len;
        }

        var result = original.ToList();
        result.RemoveRange(furn.DataStart, furn.DataLen);
        result.InsertRange(furn.DataStart, newFurnData);
        WriteUInt32(result, furn.Start + 4, (uint)newFurnData.Count);

        var oldGrupSize = System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(original.AsSpan(grup.Start + 4, 4));
        WriteUInt32(result, grup.Start + 4, oldGrupSize - (uint)removedBytes);

        return [.. result];
    }

    private static void WriteUInt32(List<byte> bytes, int offset, uint value)
    {
        var span = BitConverter.GetBytes(value);
        for (var i = 0; i < 4; i++) bytes[offset + i] = span[i];
    }

    // A Localized plugin whose mod folder also ships a BSA archive — a real voice mod bundling its
    // sound files in a .ba2. Deep-parsing/serializing this plugin forces Mutagen to resolve its
    // strings, which by default also scans the plugin's own folder for archives; with one actually
    // present, resolving BSA load-order priority needs a plugin-listings path that only exists on a
    // real Windows game install, and throws outright without one. With LocalizedStrings.ForRead's
    // BinaryReadParameters removed from TrackAsync's ImportSetter call, this test throws
    // Mutagen.Bethesda.Plugins.Exceptions.SubrecordException wrapping
    // "System.InvalidOperationException: Could not determine plugin listings path for Fallout4."
    [Fact]
    public async Task TrackAsync_LocalizedPluginWithABsaBesideIt_TracksAndMaterializesTheRealString()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-localized-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-localized-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            var door = mod.Doors.AddNew("MainDoor");
            door.Name = new TranslatedString(Language.English, "The Big Door");
            mod.UsingLocalization = true;
            // Mutagen's own WriteToBinary auto-attaches a StringsWriter rooted at the plugin's own
            // folder when UsingLocalization is set and none is supplied
            // (PluginUtilityTranslation.SetStringsWriter) — the same shape a real mod tool produces.
            mod.WriteToBinary(pluginPath);

            // The dummy archive that forces the branch above. Mutagen's own archive-listing check
            // (CachedArchiveListingDetailsProvider.IsIni) forces the plugin-listings-dependent lazy
            // payload for *every* ".ba2" the scan finds, before it even asks whether the file is
            // applicable to this plugin's own ModKey — so a name that deliberately does not match
            // "Fixture" still reproduces the crash, while never being handed to the (real) BSA reader
            // afterward, which a zero-byte file would fail to parse for an unrelated reason.
            File.WriteAllBytes(Path.Combine(modFolder, "UnrelatedMod - Main.ba2"), []);

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);
            await service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits);

            Assert.True(SourceRepository.IsTracked(modFolder));

            var sourceFile = SourceUnitResolver.FlatSourcePath(
                modFolder, "Fixture.esp", "door", door.FormKey.ToString(), "MainDoor", GameRelease.Fallout4);
            Assert.True(File.Exists(sourceFile), $"expected {sourceFile}");
            var sourceText = await File.ReadAllTextAsync(sourceFile);
            Assert.Contains("The Big Door", sourceText);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // The sibling of the test above with its strings deleted — must be refused by name, never
    // silently (TranslatedString.TryLookup returns false for a missing file with no exception at
    // all) and never with Mutagen's own listings-path exception. The explicit FindMissingStringsFile
    // check is load-bearing, not redundant with the round-trip gate: without it the missing English
    // string makes the round-trip gate's own recompile diverge from the original, so TrackAsync
    // throws SourceRoundTripFailedException — another unrelated-sounding error instead of the
    // missing file's name.
    [Fact]
    public async Task TrackAsync_LocalizedPluginMissingItsStringsFile_RefusesNamingTheMissingFile()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-localized-missing-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-localized-missing-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            var door = mod.Doors.AddNew("MainDoor");
            door.Name = new TranslatedString(Language.English, "The Big Door");
            mod.UsingLocalization = true;
            mod.WriteToBinary(pluginPath);

            // The strings Mutagen just wrote, gone — as if the mod's Strings/ folder never shipped
            // with the download, or was deleted by hand.
            Directory.Delete(Path.Combine(modFolder, "Strings"), recursive: true);

            using var manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ILoadOrderMirror mirror = manager;
            mirror.Reconcile(
                gameDir,
                [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            var service = new TrackService(NullLogger<TrackService>.Instance);
            var ex = await Assert.ThrowsAsync<MissingLocalizationStringsException>(
                () => service.TrackAsync(mirror.LoadOrder!, "FixtureMod", SourcePreset.Edits));

            // Fallout4 names its strings files by ISO language code (GameConstants.Fallout4's own
            // StringsLanguageFormat.Iso), not the full language name.
            Assert.Contains("Fixture_en.STRINGS", ex.Message);
            Assert.False(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }
}
