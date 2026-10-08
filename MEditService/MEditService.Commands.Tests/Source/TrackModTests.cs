using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.Source;

public sealed class TrackModTests
{
    [Fact]
    public async Task TrackMod_OfAModThatProvidesNoPlugin_RefusesThatModWithoutThrowing()
    {
        using var gameDir = new ScratchDirectory("medit-track-noorigin-game-");
        var loadOrder = new LoadOrderSnapshot(gameDir, null, GameRelease.Fallout4, [], [], []);

        var result = await TrackEveryPluginOf.ModAsync(loadOrder, "NoSuchMod");

        Assert.Null(result.SelectionRefusal);
        var refusal = Assert.Single(result.Refused);
        Assert.Equal(("NoSuchMod", TrackRefusal.ModProvidesNoPlugin), (refusal.Item, refusal.Refusal));
        Assert.Contains("NoSuchMod", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TrackMod_RefusesTheWholeMod_WhenOnePluginCannotBeRead_WritingNothing()
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

        var result = await TrackEveryPluginOf.ModAsync(loadOrder, "FixtureMod", new LockedPluginAdapter("Locked.esp"));

        Assert.Empty(result.Landed);
        var refusal = Assert.Single(result.Refused);
        Assert.Equal(("FixtureMod", TrackRefusal.RoundTripFailed), (refusal.Item, refusal.Refusal));
        Assert.Contains("Locked.esp", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("cannot be read", refusal.Message, StringComparison.Ordinal);
        Assert.False(SourceRepository.IsTracked(modFolder));
        Assert.False(Directory.Exists(Path.Combine(modFolder, ".git")));
        Assert.False(Directory.Exists(Path.Combine(modFolder, "plugin-source")));
    }

    private sealed class LockedPluginAdapter(string lockedName) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override bool CanRead(RegisteredPlugin plugin) =>
            !plugin.Name.Equals(lockedName, StringComparison.OrdinalIgnoreCase) && base.CanRead(plugin);

        public override Task WriteFromTreeAsync(
            IReadOnlyList<TreeFile> files, string destinationPath,
            IReadOnlyList<string> masterOrder, CancellationToken cancel = default) =>
            TestAdapters.Mutagen().WriteFromTreeAsync(files, destinationPath, masterOrder, cancel);
    }

    [Fact]
    public async Task TrackMod_RealLoadOrder_TracksTheModFolder_HoldingEachRecordWithoutCarriageReturns()
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
        await TrackEveryPluginOf.ModAsync(loadOrder, "FixtureMod");

        Assert.True(SourceRepository.IsTracked(modFolder));

        var plugin = new PluginAddress("Fixture.esp", "FixtureMod");
        var first = TrackedTree.Document(modFolder, plugin, npc1.FormKey.ToString()).Require();
        var second = TrackedTree.Document(modFolder, plugin, npc2.FormKey.ToString()).Require();
        Assert.Equal("FirstNpc", first.EditorId);
        Assert.Equal("SecondNpc", second.EditorId);

        using var roundTripped = JsonDocument.Parse(RecordTextCodec.RoundTrip(first.Body, GameRelease.Fallout4, "npc_"));
        Assert.Equal(npc1.FormKey.ToString(), roundTripped.RootElement.GetProperty("FormKey").GetString());

        Assert.DoesNotContain(
            TreeDocuments.Of(SourceRepository.Open(TestMod.In(modFolder), GameRelease.Fallout4).Require(), plugin),
            document => document.Body.Contains('\r'));
    }

    [Fact]
    public async Task TrackMod_OfAPluginInAModWithARepository_RefusesBeforeParsingIt()
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
        var result = (await TrackEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.AlreadyTracked, result.Refusal);
    }

    [Fact]
    public async Task TrackMod_OfAMod_TracksOnlyThePluginsItProvides_NotAnotherModsPluginOfTheSameFileName()
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

        var result = await TrackEveryPluginOf.ModAsync(loadOrder, "ModA");

        Assert.Equal([new PluginAddress("Same.esp", "ModA")], Assert.Single(result.Landed).Outcome.Tracked);
        Assert.True(SourceRepository.IsTracked(modA));
        Assert.False(SourceRepository.IsTracked(modB));
    }

    [Fact]
    public async Task TrackMod_OverTwoPluginsOfOneOrigin_ProgressStepsBetweenThePlugins_AndEndsIdle()
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

        var notifications = new InMemoryNotificationPublisher();
        await TrackEveryPluginOf.ModAsync(loadOrder, "FixtureMod", notifications: notifications);

        var observed = notifications.Notifications.OfType<TrackProgressNotification>().Select(n => n.Progress).ToList();
        Assert.Contains(observed, p => p.Phase == TrackPhase.Serializing && p.PluginsDone > 0 && p.PluginsDone < p.PluginsTotal);
        Assert.All(observed.Where(p => p.Phase != TrackPhase.Idle), p => Assert.Equal("FixtureMod", p.Mod));
        Assert.Equal(TrackPhase.Idle, observed[^1].Phase);
    }

    [Fact]
    public async Task TrackMod_WithARecordThatFailsToRoundTrip_RefusesAndCommitsNothing()
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

        var adapter = new ForgedTreeWriteAdapter("Fixture.esp", DeserializeThenCorruptTheNpc);

        var result = (await TrackEveryPluginOf.ModAsync(loadOrder, "FixtureMod", adapter)).Only();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains(npc.FormKey.ToString(), result.Message);
        Assert.Contains("OriginalName", result.Message);
        Assert.False(SourceRepository.IsTracked(modFolder));
    }

    [Fact]
    public async Task TrackMod_WithAFloatFieldThatFailsToRoundTrip_RefusesNamingTheRecordAndTheField()
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

        var adapter = new ForgedTreeWriteAdapter("Fixture.esp", DeserializeThenMutateTheFloat);

        var result = (await TrackEveryPluginOf.ModAsync(loadOrder, "FixtureMod", adapter)).Only();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains(npc.FormKey.ToString(), result.Message);
        Assert.Contains("Npc", result.Message);
        Assert.Contains("HeightMin", result.Message);
        Assert.False(SourceRepository.IsTracked(modFolder));
    }

    [Fact]
    public async Task TrackMod_WithOpaqueTes4HeaderSubrecordsSet_TracksSuccessfully()
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

        await TrackEveryPluginOf.ModAsync(loadOrder, "FixtureMod");

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
    public async Task TrackMod_ForEveryAllowListedHeaderField_RefusesNamingItWhenCorruptedAlone(
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

        var adapter = new ForgedTreeWriteAdapter("Fixture.esp", DeserializeThenCorrupt);

        var result = (await TrackEveryPluginOf.ModAsync(loadOrder, "FixtureMod", adapter)).Only();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains($"TES4 header field '{fieldName}'", result.Message);
        Assert.False(SourceRepository.IsTracked(modFolder));
    }

    [Fact]
    public async Task TrackMod_WithARecordThatOnlyGainsSubrecordsOnRewrite_RefusesNamingTheRealFieldNotSubrecordInventory()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-furn-insert-");
        using var gameDir = new ScratchDirectory("medit-trackservice-furn-insert-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Furniture.AddNew("TestFurn");
        mod.WriteToBinary(pluginPath);
        await File.WriteAllBytesAsync(pluginPath, PluginBinaryForge.WithoutSubrecords(await File.ReadAllBytesAsync(pluginPath), "FURN", "FNAM", "MNAM"));

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);
        var result = (await TrackEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.DoesNotContain("is missing", result.Message);
        Assert.DoesNotContain("FNAM", result.Message);
        Assert.DoesNotContain("MNAM", result.Message);
        Assert.Contains("Furniture", result.Message);
        Assert.Contains("Flags", result.Message);
        Assert.False(SourceRepository.IsTracked(modFolder));
    }

    [Fact]
    public async Task TrackMod_LocalizedPluginWithABsaBesideIt_TracksAndMaterializesTheRealString()
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
        await TrackEveryPluginOf.ModAsync(loadOrder, "FixtureMod");

        Assert.True(SourceRepository.IsTracked(modFolder));

        var sourceText = TrackedTree.Document(modFolder, new PluginAddress("Fixture.esp", "FixtureMod"), door.FormKey.ToString()).Require().Body;
        Assert.Contains("The Big Door", sourceText);
    }

    [Fact]
    public async Task TrackMod_LocalizedPluginMissingItsStringsFile_RefusesNamingTheMissingFile_SinceMutagenLookupOfAMissingFileDoesNotThrow()
    {
        using var modFolder = new ScratchDirectory("medit-trackservice-localized-missing-");
        using var gameDir = new ScratchDirectory("medit-trackservice-localized-missing-game-");
        var (pluginPath, _) = WriteLocalizedPluginWhoseStringsMutagenWritesBesideIt(modFolder);

        var stringsFolderAsIfItNeverShippedWithTheDownload = Path.Combine(modFolder, "Strings");
        Directory.Delete(stringsFolderAsIfItNeverShippedWithTheDownload, recursive: true);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Slot: 0, Enabled: true, Winning: true)]);
        var result = (await TrackEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

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
