using System.Security.Cryptography;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Newtonsoft;
using Mutagen.Bethesda.Strings;
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.Source;

/// <summary>A small synthetic fixture, not the mega-plugin: mega-scale timing is a measured,
/// reported number, not a suite-gating assertion.</summary>
public sealed class TrackServiceTests
{
    // Track answers with a refusal for every way out it has, so the endpoint maps one value rather
    // than catching one exception type per outcome.
    [Fact]
    public async Task TrackAsync_OfAPluginTheLoadOrderDoesNotHold_RefusesItWithoutThrowing()
    {
        var gameDir = Directory.CreateTempSubdirectory("medit-track-noorigin-game-").FullName;
        try
        {
            var loadOrder = new LoadOrderSnapshot(gameDir, null, GameRelease.Fallout4, []);

            var result = await new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackAsync(loadOrder, [new PluginAddress("NoSuch.esp", "NoSuchMod")], SourcePreset.Edits);

            var refused = Assert.Single(result.Refused);
            Assert.Equal(TrackRefusal.PluginNotLoaded, refused.Refusal);
            Assert.Contains("NoSuchMod", refused.Message, StringComparison.Ordinal);
        }
        finally
        {
            SafeDelete(gameDir);
        }
    }

    // A copy the Plugin adapter cannot read has no bytes to deep-parse, so Track refuses it on its
    // own. The adapter answers, not the disk: this file exists.
    [Fact]
    public async Task TrackAsync_RefusesACopyTheAdapterCannotRead_AndTracksTheRest()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-track-unopened-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-track-unopened-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("FirstNpc");
            mod.WriteToBinary(pluginPath);

            var heldElsewhere = Path.Combine(modFolder, "Locked.esp");
            new Fallout4Mod(ModKey.FromFileName("Locked.esp"), Fallout4Release.Fallout4).WriteToBinary(heldElsewhere);

            var loadOrder = new LoadOrderSnapshot(gameDir, null, GameRelease.Fallout4,
            [
                new RegisteredCopy("Fixture.esp", "FixtureMod", pluginPath, 0, Enabled: true, Winning: true),
                new RegisteredCopy("Locked.esp", "FixtureMod", heldElsewhere, 1, Enabled: true, Winning: true),
            ]);

            var result = await new TrackService(NullLogger<TrackService>.Instance, new LockedPluginAdapter("Locked.esp"))
                .TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits);

            Assert.Equal([new PluginAddress("Fixture.esp", "FixtureMod")], result.Landed);
            var refused = Assert.Single(result.Refused);
            Assert.Equal((new PluginAddress("Locked.esp", "FixtureMod"), TrackRefusal.RoundTripFailed), (refused.Plugin, refused.Refusal));
            Assert.Contains("cannot be read", refused.Message, StringComparison.Ordinal);
            Assert.True(Directory.Exists(Path.Combine(modFolder, SourceRepository.RootFor("Fixture.esp"))));
            Assert.False(Directory.Exists(Path.Combine(modFolder, SourceRepository.RootFor("Locked.esp"))));
        }
        finally
        {
            SafeDelete(modFolder);
            SafeDelete(gameDir);
        }
    }

    // The real adapter over every file but one, which another tool holds against a reader; the
    // round-trip gate's scratch write is the real one too.
    private sealed class LockedPluginAdapter(string lockedName) : ReadOnlyPluginAdapter
    {
        public override bool CanRead(ModPath modPath) =>
            !modPath.ModKey.FileName.String.Equals(lockedName, StringComparison.OrdinalIgnoreCase) && base.CanRead(modPath);

        public override Task WriteFromTreeAsync(
            IReadOnlyList<TreeFile> files, string destinationPath, CancellationToken cancel = default) =>
            TestAdapters.Mutagen().WriteFromTreeAsync(files, destinationPath, cancel);
    }

    private static void SafeDelete(string folder)
    {
        try { Directory.Delete(folder, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

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

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
            await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits);

            Assert.True(SourceRepository.IsTracked(modFolder));

            // Key layout paths: root header, and each flat NPC under its own group folder.
            var sourceRoot = Path.Combine(modFolder, SourceRepository.RootFor("Fixture.esp"));
            var rootHeader = Path.Combine(sourceRoot, "RecordData.json");
            Assert.True(File.Exists(rootHeader), $"expected {rootHeader}");

            // Computing the path alone cannot name the file without knowing its order index; the
            // repository finds it by FormKey suffix regardless of position.
            var sourceFile1 = SourceDocumentPath.Of(
                modFolder, "Fixture.esp", "npc_", npc1.FormKey.ToString(), "FirstNpc", GameRelease.Fallout4);
            var sourceFile2 = SourceDocumentPath.Of(
                modFolder, "Fixture.esp", "npc_", npc2.FormKey.ToString(), "SecondNpc", GameRelease.Fallout4);
            Assert.True(File.Exists(sourceFile1), $"expected {sourceFile1}");
            Assert.True(File.Exists(sourceFile2), $"expected {sourceFile2}");

            var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
            var roundTripped = codec.DeserializeFile(sourceFile1, GameRelease.Fallout4, "npc_");
            Assert.Equal(npc1.FormKey, roundTripped.FormKey);

            // Spriggit has no role in v1 (ADR-0006) — the root document holds the mod
            // header's own fields only, no package stamp, and Track writes no sidecar beside the
            // tree.
            Assert.False(File.Exists(Path.Combine(sourceRoot, ".spriggit")));
            Assert.False(File.Exists(Path.Combine(sourceRoot, "spriggit-meta.json")));
            var rootText = await File.ReadAllTextAsync(rootHeader);
            Assert.DoesNotContain("SpriggitSource", rootText, StringComparison.Ordinal);

            // The root document is genuinely valid JSON the whole-mod door's Deserialize can read back. No
            // extraMeta argument: the generated Deserialize's extraMeta parameter hits the same
            // overload-collision defect Serialize's does.
            var deserializedMod = await MutagenJsonConverter.Instance.Deserialize(sourceRoot);
            Assert.Equal(2, deserializedMod.Npcs.Count);
            Assert.Contains(deserializedMod.Npcs, n => n.FormKey == npc1.FormKey && n.EditorID == "FirstNpc");
            Assert.Contains(deserializedMod.Npcs, n => n.FormKey == npc2.FormKey && n.EditorID == "SecondNpc");

            // No \r anywhere in the tracked tree.
            foreach (var file in Directory.EnumerateFiles(sourceRoot, "*", SearchOption.AllDirectories))
                Assert.DoesNotContain((byte)'\r', await File.ReadAllBytesAsync(file));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // The pinned trailer set (Upstream-Version, Binary-SHA256, Meta-SHA256 — ADR-0003)
    // must ship all three.
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

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
            await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits);

            var gitDir = Path.Combine(modFolder, ".git");
            var body = GitProbe.Run(gitDir, modFolder, "log", "-1", "--format=%B", "main");
            Assert.Contains($"Meta-SHA256: {expectedHash}", body);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // Positive control's index: no meta.ini beside the plugin (an authored/manually-installed
    // mod, ADR-0003) means no Meta-SHA256 trailer at all — every BaselineTrailers fact
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

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
            await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits);

            var gitDir = Path.Combine(modFolder, ".git");
            var body = GitProbe.Run(gitDir, modFolder, "log", "-1", "--format=%B", "main");
            Assert.DoesNotContain("Meta-SHA256", body);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // The already-tracked check must fire before the deep-parse loop, or the worst case runs to
    // completion before the caller learns the cheap answer was available.
    [Fact]
    public async Task TrackAsync_OfAPluginAlreadyTracked_RefusesBeforeParsingIt()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-trackservice-alreadytracked-").FullName;
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-alreadytracked-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SomeNpc");
            mod.WriteToBinary(pluginPath);

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            // Track the plugin once, for real, before corrupting anything — a dummy path shaped like
            // what TrackAsync would actually have written, though the content doesn't matter for
            // this test: only that its source root is committed does.
            PluginBaselines.Track(
                modFolder, SourcePreset.Edits,
                [new TreeFile("source/Fixture.esp/Npcs/000001_Fixture.esp.json", "{}"u8.ToArray())]);

            // The load order already parsed a good copy; the file on disk is corrupted afterward —
            // exactly the state TrackService's own fresh deep parse must fail against if it is
            // ever reached.
            File.WriteAllBytes(pluginPath, [0x00, 0x01, 0x02, 0x03]);

            var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
            var result = (await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits)).Only();

            Assert.False(result.Applied);
            Assert.Equal(TrackRefusal.AlreadyTracked, result.Refusal);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // The only copy under this origin resolves to the game's own Data directory (PluginOrigin.
    // DataDirectory), which LoadOrderSnapshot.ModFolderOf returns null for — Track must refuse rather than
    // Path.GetDirectoryName'ing its way to a repository inside Data.
    [Fact]
    public async Task TrackAsync_WithOnlyADataOriginCopy_RefusesWithoutInitializingARepository()
    {
        var gameDir = Directory.CreateTempSubdirectory("medit-trackservice-dataorigin-").FullName;
        try
        {
            var pluginPath = Path.Combine(gameDir, "Fixture.esp");
            var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SomeNpc");
            mod.WriteToBinary(pluginPath);

            var loadOrder = new LoadOrderSnapshot(gameDir, null, GameRelease.Fallout4,
            [
                new RegisteredCopy("Fixture.esp", PluginOrigin.DataDirectory, pluginPath, 0, Enabled: true, Winning: true),
            ]);

            var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
            var result = (await service.TrackModAsync(
                loadOrder, PluginOrigin.DataDirectory, SourcePreset.Edits)).Only();

            Assert.False(result.Applied);
            Assert.Equal(TrackRefusal.DataDirectoryOrigin, result.Refusal);
            Assert.Empty(Directory.EnumerateDirectories(gameDir, ".git", SearchOption.AllDirectories));
        }
        finally
        {
            SafeDelete(gameDir);
        }
    }

    // Serializing's granularity is per-plugin, so a genuine 0 < done < total tick needs two plugins
    // under one origin: the observation point falls between the first plugin's door call and the
    // second's.
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

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([
                    new LoadOrderEntry("First.esp", firstPluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true),
                    new LoadOrderEntry("Second.esp", secondPluginPath, "FixtureMod", Slot: 1, Enabled: true, Winning: true),
                ]));

            var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
            Assert.Equal(TrackPhase.Idle, service.Progress.Phase);

            var observed = new List<TrackProgress>();
            var trackTask = service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits);
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

    // ADR-0006 invariant 2: the gate runs at Track over every record of the plugin. A wrapper that
    // deserializes for real but counts its calls is what shows the gate genuinely ran, which Track
    // merely succeeding would not.
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

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            var deserializeCalls = 0;
            async Task<IMod> CountingDeserialize(string folder, CancellationToken ct)
            {
                deserializeCalls++;
                return await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
            }

            var service = new TrackService(NullLogger<TrackService>.Instance, new ForgedTreeWriteAdapter("Fixture.esp", CountingDeserialize));

            await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits);

            Assert.Equal(1, deserializeCalls);
            Assert.True(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // ADR-0006 invariant 2: a plugin that does not round-trip is refused, with the failing record
    // named.
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

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            static async Task<IMod> DeserializeThenCorruptTheNpc(string folder, CancellationToken ct)
            {
                var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
                deserialized.Npcs.First().EditorID += "Corrupted";
                return deserialized;
            }

            var service = new TrackService(NullLogger<TrackService>.Instance, new ForgedTreeWriteAdapter("Fixture.esp", DeserializeThenCorruptTheNpc));

            var result = (await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits)).Only();

            Assert.False(result.Applied);
            Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

            Assert.Contains(npc.FormKey.ToString(), result.Message);
            Assert.Contains("OriginalName", result.Message);
            Assert.False(SourceRepository.IsTracked(modFolder));
            Assert.False(Directory.Exists(Path.Combine(modFolder, ".git")));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // Track refuses on any content difference, a mutated float as well as a string, with record type,
    // FormKey and field name in the message. HeightMin is set to a non-default value first so "the
    // mutation changed it" is unambiguous.
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

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            static async Task<IMod> DeserializeThenMutateTheFloat(string folder, CancellationToken ct)
            {
                var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
                deserialized.Npcs.First().HeightMin += 1.0f;
                return deserialized;
            }

            var service = new TrackService(NullLogger<TrackService>.Instance, new ForgedTreeWriteAdapter("Fixture.esp", DeserializeThenMutateTheFloat));

            var result = (await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits)).Only();

            Assert.False(result.Applied);
            Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

            Assert.Contains(npc.FormKey.ToString(), result.Message);
            Assert.Contains("Npc", result.Message);
            Assert.Contains("HeightMin", result.Message);
            Assert.False(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // Real plugins carry opaque TES4 header subrecords like INTV, which the generated header codec must
    // carry faithfully through the round trip. Not vacuous: nulling recompiled.ModHeader.INTV inside a
    // forged deserializer makes this throw.
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

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());

            await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits);

            Assert.True(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // An allow-list entry with no test that corrupts that field alone and asserts the refusal names
    // it is a claim nobody can cash.
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

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            async Task<IMod> DeserializeThenCorrupt(string folder, CancellationToken ct)
            {
                var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
                corrupt(deserialized.ModHeader);
                return deserialized;
            }

            var service = new TrackService(NullLogger<TrackService>.Instance, new ForgedTreeWriteAdapter("Fixture.esp", DeserializeThenCorrupt));

            var result = (await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits)).Only();

            Assert.False(result.Applied);
            Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

            Assert.Contains($"TES4 header field '{fieldName}'", result.Message);
            Assert.False(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

    // A rewrite that only adds subrecords must not be refused by the subrecord-inventory check.
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

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
            var result = (await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits)).Only();

            Assert.False(result.Applied);
            Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

            Assert.DoesNotContain("is missing", result.Message);
            Assert.DoesNotContain("FNAM", result.Message);
            Assert.DoesNotContain("MNAM", result.Message);
            Assert.Contains("Furniture", result.Message);
            Assert.Contains("Flags", result.Message);
            Assert.False(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }

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

    // Deep-parsing a Localized plugin makes Mutagen resolve its strings, which scans for archives;
    // with one present, resolving BSA priority needs a plugin-listings path only a Windows install
    // has.
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

            // Mutagen's archive-listing check forces the plugin-listings-dependent lazy payload for
            // every ".ba2" the scan finds, before asking whether the file applies to this ModKey.
            File.WriteAllBytes(Path.Combine(modFolder, "UnrelatedMod - Main.ba2"), []);

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
            await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits);

            Assert.True(SourceRepository.IsTracked(modFolder));

            var sourceFile = SourceDocumentPath.Of(
                modFolder, "Fixture.esp", "Door", door.FormKey.ToString(), "MainDoor", GameRelease.Fallout4);
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

    // Must be refused by name: TranslatedString.TryLookup returns false for a missing file with no
    // exception.
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

            var loadOrder = new LoadOrderSnapshot(
                gameDir, gameDir, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]));

            var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
            var result = (await service.TrackModAsync(loadOrder, "FixtureMod", SourcePreset.Edits)).Only();

            Assert.False(result.Applied);
            Assert.Equal(TrackRefusal.MissingLocalizationStrings, result.Refusal);

            // Fallout4 names its strings files by ISO language code (GameConstants.Fallout4's own
            // StringsLanguageFormat.Iso), not the full language name.
            Assert.Contains("Fixture_en.STRINGS", result.Message);
            Assert.False(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
            Directory.Delete(gameDir, recursive: true);
        }
    }
}
