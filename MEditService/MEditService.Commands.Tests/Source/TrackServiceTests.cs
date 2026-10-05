using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.Source;

public sealed class TrackServiceTests
{
    [Fact]
    public async Task TrackAsync_OfAModThatProvidesNoPlugin_RefusesThatModWithoutThrowing()
    {
        using var gameDir = new ScratchDirectory("medit-track-noorigin-game-");
        var loadOrder = new LoadOrderSnapshot(gameDir, null, GameRelease.Fallout4, [], [], []);

        var result = await new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackAsync(loadOrder, ["NoSuchMod"]);

        Assert.Null(result.SelectionRefusal);
        var refusal = Assert.Single(result.RefusedMods);
        Assert.Equal(("NoSuchMod", TrackRefusal.ModProvidesNoPlugin), (refusal.Mod, refusal.Refusal));
        Assert.Contains("NoSuchMod", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TrackAsync_RefusesAPluginTheAdapterCannotRead_AndTracksTheRest()
    {
        using var modFolder = new ScratchDirectory("medit-track-unopened-");
        using var gameDir = new ScratchDirectory("medit-track-unopened-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("FirstNpc");
        mod.WriteToBinary(pluginPath);

        var existingFileTheAdapterCannotRead = Path.Combine(modFolder, "Locked.esp");
        new Fallout4Mod(ModKey.FromFileName("Locked.esp"), Fallout4Release.Fallout4).WriteToBinary(existingFileTheAdapterCannotRead);

        var loadOrder = SnapshotPlugins.Snapshot(gameDir, null, GameRelease.Fallout4,
        [
            new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Locked.esp", existingFileTheAdapterCannotRead, "FixtureMod", 1, Enabled: true, Winning: true),
        ]);

        var result = await new TrackService(NullLogger<TrackService>.Instance, new LockedPluginAdapter("Locked.esp"))
            .TrackModAsync(loadOrder, "FixtureMod");

        Assert.Equal([new PluginAddress("Fixture.esp", "FixtureMod")], result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((new PluginAddress("Locked.esp", "FixtureMod"), TrackRefusal.RoundTripFailed), (refused.Plugin, refused.Refusal));
        Assert.Contains("cannot be read", refused.Message, StringComparison.Ordinal);
        Assert.True(SourceRepository.HoldsTreeFor(modFolder, "Fixture.esp"));
        Assert.False(SourceRepository.HoldsTreeFor(modFolder, "Locked.esp"));
    }

    private sealed class LockedPluginAdapter(string lockedName) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override bool CanRead(ModPath modPath) =>
            !modPath.ModKey.FileName.String.Equals(lockedName, StringComparison.OrdinalIgnoreCase) && base.CanRead(modPath);

        public override Task WriteFromTreeAsync(
            IReadOnlyList<TreeFile> files, string destinationPath, CancellationToken cancel = default) =>
            TestAdapters.Mutagen().WriteFromTreeAsync(files, destinationPath, cancel);
    }

    [Fact]
    public async Task TrackAsync_RealLoadOrder_TracksTheModFolder_HoldingEachRecordWithoutCarriageReturns()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-");
        using var gameDir = new ScratchDirectory("medit-trackservice-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc1 = mod.Npcs.AddNew("FirstNpc");
        var npc2 = mod.Npcs.AddNew("SecondNpc");
        mod.WriteToBinary(pluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);

        var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
        await service.TrackModAsync(loadOrder, "FixtureMod");

        Assert.True(SourceRepository.IsTracked(modFolder));

        var plugin = new PluginAddress("Fixture.esp", "FixtureMod");
        var first = TrackedTree.Document(modFolder, plugin, npc1.FormKey.ToString()).Require();
        var second = TrackedTree.Document(modFolder, plugin, npc2.FormKey.ToString()).Require();
        Assert.Equal("FirstNpc", first.EditorId);
        Assert.Equal("SecondNpc", second.EditorId);

        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var roundTripped = codec.DeserializeFromBytes(System.Text.Encoding.UTF8.GetBytes(first.Body), GameRelease.Fallout4, "npc_");
        Assert.Equal(npc1.FormKey, roundTripped.FormKey);

        Assert.DoesNotContain(
            TreeDocuments.Of(SourceRepository.Open(TestMod.In(modFolder), GameRelease.Fallout4).Require(), plugin),
            document => document.Body.Contains('\r'));
    }

    [Fact]
    public async Task TrackAsync_OfAPluginInAModWithARepository_RefusesBeforeParsingIt()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-alreadytracked-");
        using var gameDir = new ScratchDirectory("medit-trackservice-alreadytracked-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("SomeNpc");
        TrackedTemplates.WriteTracked(modFolder, mod);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);

        byte[] notAPluginSoAnyDeepParseFails = [0x00, 0x01, 0x02, 0x03];
        File.WriteAllBytes(pluginPath, notAPluginSoAnyDeepParseFails);

        var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
        var result = (await service.TrackModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.AlreadyTracked, result.Refusal);
    }

    [Fact]
    public async Task TrackAsync_OfAMod_TracksOnlyThePluginsItProvides_NotAnotherModsPluginOfTheSameFileName()
    {
        using var modA = new ScratchDirectory("medit-trackservice-twomods-a-");
        using var modB = new ScratchDirectory("medit-trackservice-twomods-b-");
        using var gameDir = new ScratchDirectory("medit-trackservice-twomods-game-");
        var pathA = Path.Combine(modA, "Same.esp");
        var pathB = Path.Combine(modB, "Same.esp");
        foreach (var path in new[] { pathA, pathB })
        {
            var mod = new Fallout4Mod(ModKey.FromFileName("Same.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SomeNpc");
            mod.WriteToBinary(path);
        }

        var loadOrder = SnapshotPlugins.Snapshot(gameDir, null, GameRelease.Fallout4,
        [
            new LoadOrderEntry("Same.esp", pathA, "ModA", Slot: 0, Enabled: true, Winning: false),
            new LoadOrderEntry("Same.esp", pathB, "ModB", Slot: 1, Enabled: true, Winning: true),
        ]);

        var result = await new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackAsync(loadOrder, ["ModA"]);

        Assert.Equal([new PluginAddress("Same.esp", "ModA")], result.Landed);
        Assert.True(SourceRepository.IsTracked(modA));
        Assert.False(SourceRepository.IsTracked(modB));
    }

    [Fact]
    public async Task TrackAsync_OverTwoPluginsOfOneOrigin_ProgressStepsBetweenThePluginsObservableMidFlight()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-progress-");
        using var gameDir = new ScratchDirectory("medit-trackservice-progress-game-");
        var firstPluginPath = Path.Combine(modFolder, "First.esp");
        var firstMod = new Fallout4Mod(ModKey.FromFileName("First.esp"), Fallout4Release.Fallout4);
        firstMod.Npcs.AddNew("OnlyNpc");
        firstMod.WriteToBinary(firstPluginPath);

        var secondPluginPath = Path.Combine(modFolder, "Second.esp");
        var secondMod = new Fallout4Mod(ModKey.FromFileName("Second.esp"), Fallout4Release.Fallout4);
        for (var i = 0; i < 400; i++) secondMod.Npcs.AddNew($"Npc{i}");
        secondMod.WriteToBinary(secondPluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [
                new LoadOrderEntry("First.esp", firstPluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true),
                new LoadOrderEntry("Second.esp", secondPluginPath, "FixtureMod", Slot: 1, Enabled: true, Winning: true),
            ]);

        var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
        Assert.Equal(TrackPhase.Idle, service.Progress.Phase);

        var observed = new List<TrackProgress>();
        var trackTask = service.TrackModAsync(loadOrder, "FixtureMod");
        while (!trackTask.IsCompleted)
            observed.Add(service.Progress);
        await trackTask;

        Assert.Contains(observed, p => p.Phase == TrackPhase.Serializing && p.PluginsDone > 0 && p.PluginsDone < p.PluginsTotal);
        Assert.All(observed.Where(p => p.Phase != TrackPhase.Idle), p => Assert.Equal("FixtureMod", p.Mod));
        Assert.Equal(TrackPhase.Idle, service.Progress.Phase);
    }

    [Fact]
    public async Task TrackAsync_RealLoadOrder_RunsTheRoundTripGateForRealBeforeSucceeding()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-gateran-");
        using var gameDir = new ScratchDirectory("medit-trackservice-gateran-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("SomeNpc");
        mod.WriteToBinary(pluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);

        var deserializeCalls = 0;
        async Task<IMod> CountingDeserialize(string folder, CancellationToken ct)
        {
            deserializeCalls++;
            return await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
        }

        var service = new TrackService(NullLogger<TrackService>.Instance, new ForgedTreeWriteAdapter("Fixture.esp", CountingDeserialize));

        await service.TrackModAsync(loadOrder, "FixtureMod");

        Assert.Equal(1, deserializeCalls);
        Assert.True(SourceRepository.IsTracked(modFolder));
    }

    [Fact]
    public async Task TrackAsync_WithARecordThatFailsToRoundTrip_RefusesAndCommitsNothing()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-badroundtrip-");
        using var gameDir = new ScratchDirectory("medit-trackservice-badroundtrip-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("OriginalName");
        mod.WriteToBinary(pluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);

        static async Task<IMod> DeserializeThenCorruptTheNpc(string folder, CancellationToken ct)
        {
            var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
            deserialized.Npcs.First().EditorID += "Corrupted";
            return deserialized;
        }

        var service = new TrackService(NullLogger<TrackService>.Instance, new ForgedTreeWriteAdapter("Fixture.esp", DeserializeThenCorruptTheNpc));

        var result = (await service.TrackModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains(npc.FormKey.ToString(), result.Message);
        Assert.Contains("OriginalName", result.Message);
        Assert.False(SourceRepository.IsTracked(modFolder));
    }

    [Fact]
    public async Task TrackAsync_WithAFloatFieldThatFailsToRoundTrip_RefusesNamingTheRecordAndTheField()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-floatroundtrip-");
        using var gameDir = new ScratchDirectory("medit-trackservice-floatroundtrip-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("SomeNpc");
        const float nonDefaultSoTheMutationUnambiguouslyChangesIt = 1.5f;
        npc.HeightMin = nonDefaultSoTheMutationUnambiguouslyChangesIt;
        mod.WriteToBinary(pluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);

        static async Task<IMod> DeserializeThenMutateTheFloat(string folder, CancellationToken ct)
        {
            var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
            deserialized.Npcs.First().HeightMin += 1.0f;
            return deserialized;
        }

        var service = new TrackService(NullLogger<TrackService>.Instance, new ForgedTreeWriteAdapter("Fixture.esp", DeserializeThenMutateTheFloat));

        var result = (await service.TrackModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains(npc.FormKey.ToString(), result.Message);
        Assert.Contains("Npc", result.Message);
        Assert.Contains("HeightMin", result.Message);
        Assert.False(SourceRepository.IsTracked(modFolder));
    }

    [Fact]
    public async Task TrackAsync_WithOpaqueTes4HeaderSubrecordsSet_TracksSuccessfully()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-opaqueheader-");
        using var gameDir = new ScratchDirectory("medit-trackservice-opaqueheader-game-");
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

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);

        var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());

        await service.TrackModAsync(loadOrder, "FixtureMod");

        Assert.True(SourceRepository.IsTracked(modFolder));
    }

    public static IEnumerable<object[]> HeaderFieldCorruptionsMirroringCodecsOpaqueHeaderFields()
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
    [MemberData(nameof(HeaderFieldCorruptionsMirroringCodecsOpaqueHeaderFields))]
    public async Task TrackAsync_ForEveryAllowListedHeaderField_RefusesNamingItWhenCorruptedAlone(
        string fieldName, Action<Fallout4ModHeader> setBaseline, Action<Fallout4ModHeader> corrupt)
    {
        using var modFolder = new ScratchDirectory($"medit-trackservice-header-{fieldName}-");
        using var gameDir = new ScratchDirectory($"medit-trackservice-header-{fieldName}-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("SomeNpc");
        setBaseline(mod.ModHeader);
        mod.WriteToBinary(pluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);

        async Task<IMod> DeserializeThenCorrupt(string folder, CancellationToken ct)
        {
            var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
            corrupt(deserialized.ModHeader);
            return deserialized;
        }

        var service = new TrackService(NullLogger<TrackService>.Instance, new ForgedTreeWriteAdapter("Fixture.esp", DeserializeThenCorrupt));

        var result = (await service.TrackModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains($"TES4 header field '{fieldName}'", result.Message);
        Assert.False(SourceRepository.IsTracked(modFolder));
    }

    [Fact]
    public async Task TrackAsync_WithARecordThatOnlyGainsSubrecordsOnRewrite_RefusesNamingTheRealFieldNotSubrecordInventory()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-furn-insert-");
        using var gameDir = new ScratchDirectory("medit-trackservice-furn-insert-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Furniture.AddNew("TestFurn");
        mod.WriteToBinary(pluginPath);
        await File.WriteAllBytesAsync(pluginPath, StripFnamAndMnamFromTheOnlyFurnRecord(await File.ReadAllBytesAsync(pluginPath)));

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);

        var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
        var result = (await service.TrackModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.DoesNotContain("is missing", result.Message);
        Assert.DoesNotContain("FNAM", result.Message);
        Assert.DoesNotContain("MNAM", result.Message);
        Assert.Contains("Furniture", result.Message);
        Assert.Contains("Flags", result.Message);
        Assert.False(SourceRepository.IsTracked(modFolder));
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

    [Fact]
    public async Task TrackAsync_LocalizedPluginWithABsaBesideIt_TracksAndMaterializesTheRealString()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-localized-");
        using var gameDir = new ScratchDirectory("medit-trackservice-localized-game-");
        var (pluginPath, door) = WriteLocalizedPluginWhoseStringsMutagenWritesBesideIt(modFolder);

        var anyBa2MakesMutagenResolveArchivePriorityNeedingWindowsPluginListings =
            Path.Combine(modFolder, "UnrelatedMod - Main.ba2");
        File.WriteAllBytes(anyBa2MakesMutagenResolveArchivePriorityNeedingWindowsPluginListings, []);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);

        var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
        await service.TrackModAsync(loadOrder, "FixtureMod");

        Assert.True(SourceRepository.IsTracked(modFolder));

        var sourceText = TrackedTree.Document(modFolder, new PluginAddress("Fixture.esp", "FixtureMod"), door.FormKey.ToString()).Require().Body;
        Assert.Contains("The Big Door", sourceText);
    }

    [Fact]
    public async Task TrackAsync_LocalizedPluginMissingItsStringsFile_RefusesNamingTheMissingFile_SinceMutagenLookupOfAMissingFileDoesNotThrow()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-localized-missing-");
        using var gameDir = new ScratchDirectory("medit-trackservice-localized-missing-game-");
        var (pluginPath, _) = WriteLocalizedPluginWhoseStringsMutagenWritesBesideIt(modFolder);

        var stringsFolderAsIfItNeverShippedWithTheDownload = Path.Combine(modFolder, "Strings");
        Directory.Delete(stringsFolderAsIfItNeverShippedWithTheDownload, recursive: true);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);

        var service = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
        var result = (await service.TrackModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.MissingLocalizationStrings, result.Refusal);

        const string stringsFileNamedByIsoLanguageCodeNotByLanguageName = "Fixture_en.STRINGS";
        Assert.Contains(stringsFileNamedByIsoLanguageCodeNotByLanguageName, result.Message);
        Assert.False(SourceRepository.IsTracked(modFolder));
    }

    private static (string PluginPath, Door Door) WriteLocalizedPluginWhoseStringsMutagenWritesBesideIt(string modFolder)
    {
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var door = mod.Doors.AddNew("MainDoor");
        door.Name = new TranslatedString(Language.English, "The Big Door");
        mod.UsingLocalization = true;
        mod.WriteToBinary(pluginPath);
        return (pluginPath, door);
    }
}
