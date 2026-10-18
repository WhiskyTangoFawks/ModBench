using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Tests.Build;

public sealed class InitModTests
{
    [Fact]
    public async Task InitMod_OfAModThatProvidesNoPlugin_RefusesThatModWithoutThrowing()
    {
        using var gameDir = new ScratchDirectory("medit-init-noorigin-game-");
        var loadOrder = new LoadOrderSnapshot(gameDir, null, GameRelease.Fallout4, [], [], [], [], [], [], Language.English);

        var result = await InitEveryPluginOf.ModAsync(loadOrder, "NoSuchMod");

        Assert.Null(result.SelectionRefusal);
        var refusal = Assert.Single(result.Refused);
        Assert.Equal(("NoSuchMod", InitRefusal.ModProvidesNoPlugin), (refusal.Item, refusal.Refusal));
        Assert.Contains("NoSuchMod", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task InitMod_RefusesTheWholeMod_WhenOnePluginCannotBeRead_WritingNothing()
    {
        using var modFolder = new ScratchDirectory("medit-init-unopened-");
        using var gameDir = new ScratchDirectory("medit-init-unopened-game-");
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

        var result = await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod", new LockedPluginAdapter("Locked.esp"));

        Assert.Empty(result.Landed);
        var refusal = Assert.Single(result.Refused);
        Assert.Equal(("FixtureMod", InitRefusal.RoundTripFailed), (refusal.Item, refusal.Refusal));
        Assert.Contains("Locked.esp", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("cannot be read", refusal.Message, StringComparison.Ordinal);
        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
        Assert.False(Directory.Exists(Path.Combine(modFolder, ".git")));
        Assert.False(Directory.Exists(Path.Combine(modFolder, "plugin-source")));
    }

    private sealed class LockedPluginAdapter(string lockedName) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Task<Answer<PluginSource, PluginFailure>> ReadSourceOfAsync(
            RegisteredPlugin plugin, LoadOrderSnapshot loadOrder, CancellationToken cancel = default) =>
            plugin.Name.Equals(lockedName, StringComparison.OrdinalIgnoreCase)
                ? Task.FromResult<Answer<PluginSource, PluginFailure>>(PluginFailures.Inaccessible())
                : base.ReadSourceOfAsync(plugin, loadOrder, cancel);
    }

    [Fact]
    public async Task InitMod_RealLoadOrder_InitsTheMod_HoldingEachRecordWithoutCarriageReturns()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-");
        using var gameDir = new ScratchDirectory("medit-initservice-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc1 = mod.Npcs.AddNew("FirstNpc");
        var npc2 = mod.Npcs.AddNew("SecondNpc");
        mod.WriteToBinary(pluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true)]);
        await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod");

        Assert.True(TestAdapters.Source().IsSourceMod(modFolder));

        var plugin = new PluginAddress("Fixture.esp", "FixtureMod");
        var first = SourceModTree.Document(modFolder, plugin, npc1.FormKey.ToString()).Require();
        var second = SourceModTree.Document(modFolder, plugin, npc2.FormKey.ToString()).Require();
        Assert.Equal("FirstNpc", first.EditorId);
        Assert.Equal("SecondNpc", second.EditorId);

        using var roundTripped = JsonDocument.Parse(RecordTextCodec.RoundTrip(first.Body, GameRelease.Fallout4, "npc_"));
        Assert.Equal(npc1.FormKey.ToString(), roundTripped.RootElement.GetProperty("FormKey").GetString());

        Assert.DoesNotContain(
            TreeDocuments.Of(TestAdapters.Source().Open(TestMod.Of(plugin, modFolder), GameRelease.Fallout4).Require(), plugin),
            document => document.Body.Contains('\r'));
    }

    [Fact]
    public async Task InitMod_OfAPluginInAModWithARepository_RefusesBeforeParsingIt()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-alreadysource-");
        using var gameDir = new ScratchDirectory("medit-initservice-alreadysource-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("SomeNpc");
        CompiledPluginTemplates.WriteCompiledPlugin(modFolder, mod);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true)]);

        byte[] notAPluginSoAnyDeepParseFails = [0x00, 0x01, 0x02, 0x03];
        File.WriteAllBytes(pluginPath, notAPluginSoAnyDeepParseFails);
        var result = (await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(InitRefusal.AlreadyInitialized, result.Refusal);
    }

    [Fact]
    public async Task InitMod_OfAMod_TakesOnlyThePluginsItProvides_NotAnotherModsPluginOfTheSameFileName()
    {
        using var modA = new ScratchDirectory("medit-initservice-twomods-a-");
        using var modB = new ScratchDirectory("medit-initservice-twomods-b-");
        using var gameDir = new ScratchDirectory("medit-initservice-twomods-game-");
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
            new LoadOrderEntry("Same.esp", pathA, "ModA", Line: 0, Enabled: true, Winning: false),
            new LoadOrderEntry("Same.esp", pathB, "ModB", Line: 1, Enabled: true, Winning: true),
        ]);

        var result = await InitEveryPluginOf.ModAsync(loadOrder, "ModA");

        Assert.Equal([new PluginAddress("Same.esp", "ModA")], Assert.Single(result.Landed).Outcome.Plugins);
        Assert.True(TestAdapters.Source().IsSourceMod(modA));
        Assert.False(TestAdapters.Source().IsSourceMod(modB));
    }

    [Fact]
    public async Task InitMod_OverTwoPluginsOfOneOrigin_ProgressNamesTheModAndEachPhase_AndEndsAtRest()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-progress-");
        using var gameDir = new ScratchDirectory("medit-initservice-progress-game-");
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
                new LoadOrderEntry("First.esp", firstPluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true),
                new LoadOrderEntry("Second.esp", secondPluginPath, "FixtureMod", Line: 1, Enabled: true, Winning: true),
            ]);

        var notifications = new InMemoryNotificationPublisher();
        await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod", notifications: notifications);

        var observed = notifications.Notifications.OfType<DecompileAndCommitProgressNotification>().Select(n => n.Progress).ToList();
        Assert.Equal(
            [DecompileAndCommitPhase.Parsing, DecompileAndCommitPhase.Serializing, DecompileAndCommitPhase.Parsing, DecompileAndCommitPhase.Serializing,
             DecompileAndCommitPhase.ReadingFiles, DecompileAndCommitPhase.Committing],
            observed.Select(p => p.Phase).OfType<DecompileAndCommitPhase>());
        Assert.All(observed.Where(p => p.Phase is not null), p => Assert.Equal("FixtureMod", p.Mod));
        Assert.Equal(new ModlistProgress(null, null, 0, 0), observed[^1]);
    }

    [Fact]
    public async Task InitMod_WithARecordThatFailsToRoundTrip_RefusesAndCommitsNothing()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-badroundtrip-");
        using var gameDir = new ScratchDirectory("medit-initservice-badroundtrip-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("OriginalName");
        mod.WriteToBinary(pluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true)]);

        static async Task<IMod> DeserializeThenCorruptTheNpc(string folder, CancellationToken ct)
        {
            var deserialized = await Fallout4WholeMod.Deserialize(folder, ct);
            deserialized.Npcs.First().EditorID += "Corrupted";
            return deserialized;
        }

        var adapter = new ForgedTreeWriteAdapter(DeserializeThenCorruptTheNpc);

        var result = (await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod", adapter)).Only();

        Assert.False(result.Applied);
        Assert.Equal(InitRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains(npc.FormKey.ToString(), result.Message);
        Assert.Contains("OriginalName", result.Message);
        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
    }

    [Fact]
    public async Task InitMod_WithAFloatFieldThatFailsToRoundTrip_RefusesNamingTheRecordAndTheField()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-floatroundtrip-");
        using var gameDir = new ScratchDirectory("medit-initservice-floatroundtrip-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("SomeNpc");
        const float nonDefaultSoTheMutationUnambiguouslyChangesIt = 1.5f;
        npc.HeightMin = nonDefaultSoTheMutationUnambiguouslyChangesIt;
        mod.WriteToBinary(pluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true)]);

        static async Task<IMod> DeserializeThenMutateTheFloat(string folder, CancellationToken ct)
        {
            var deserialized = await Fallout4WholeMod.Deserialize(folder, ct);
            deserialized.Npcs.First().HeightMin += 1.0f;
            return deserialized;
        }

        var adapter = new ForgedTreeWriteAdapter(DeserializeThenMutateTheFloat);

        var result = (await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod", adapter)).Only();

        Assert.False(result.Applied);
        Assert.Equal(InitRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains(npc.FormKey.ToString(), result.Message);
        Assert.Contains("Npc", result.Message);
        Assert.Contains("HeightMin", result.Message);
        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
    }

    [Fact]
    public async Task InitMod_WithOpaqueTes4HeaderSubrecordsSet_Lands()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-opaqueheader-");
        using var gameDir = new ScratchDirectory("medit-initservice-opaqueheader-game-");
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
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true)]);

        await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod");

        Assert.True(TestAdapters.Source().IsSourceMod(modFolder));
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
    public async Task InitMod_ForEveryAllowListedHeaderField_RefusesNamingItWhenCorruptedAlone(
        string fieldName, Action<Fallout4ModHeader> setBaseline, Action<Fallout4ModHeader> corrupt)
    {
        using var modFolder = new ScratchDirectory($"medit-initservice-header-{fieldName}-");
        using var gameDir = new ScratchDirectory($"medit-initservice-header-{fieldName}-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("SomeNpc");
        setBaseline(mod.ModHeader);
        mod.WriteToBinary(pluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true)]);

        async Task<IMod> DeserializeThenCorrupt(string folder, CancellationToken ct)
        {
            var deserialized = await Fallout4WholeMod.Deserialize(folder, ct);
            corrupt(deserialized.ModHeader);
            return deserialized;
        }

        var adapter = new ForgedTreeWriteAdapter(DeserializeThenCorrupt);

        var result = (await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod", adapter)).Only();

        Assert.False(result.Applied);
        Assert.Equal(InitRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains($"TES4 header field '{fieldName}'", result.Message);
        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
    }

    [Fact]
    public async Task InitMod_WithARecordThatOnlyGainsSubrecordsOnRewrite_RefusesNamingTheRealFieldNotSubrecordInventory()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-furn-insert-");
        using var gameDir = new ScratchDirectory("medit-initservice-furn-insert-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Furniture.AddNew("TestFurn");
        mod.WriteToBinary(pluginPath);
        await File.WriteAllBytesAsync(pluginPath, PluginBinaryForge.WithoutSubrecords(await File.ReadAllBytesAsync(pluginPath), "FURN", "FNAM", "MNAM"));

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true)]);
        var result = (await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(InitRefusal.RoundTripFailed, result.Refusal);

        Assert.DoesNotContain("is missing", result.Message);
        Assert.DoesNotContain("FNAM", result.Message);
        Assert.DoesNotContain("MNAM", result.Message);
        Assert.Contains("Furniture", result.Message);
        Assert.Contains("Flags", result.Message);
        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
    }

    [Fact]
    public async Task InitMod_LocalizedPluginWithABsaBesideIt_ReadsItsStringsFromTheModFolder_AndMaterializesTheRealStringInTheSourceFolder()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-localized-");
        using var sourceFolder = new ScratchDirectory("medit-initservice-localized-source-");
        using var gameDir = new ScratchDirectory("medit-initservice-localized-game-");
        var (pluginPath, door) = WriteLocalizedPluginWhoseStringsMutagenWritesBesideIt(modFolder);

        var anyBa2MakesMutagenResolveArchivePriorityNeedingWindowsPluginListings =
            Path.Combine(modFolder, "UnrelatedMod - Main.ba2");
        File.WriteAllBytes(anyBa2MakesMutagenResolveArchivePriorityNeedingWindowsPluginListings, []);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true,
                NamedProvider: new PluginProvider.FromMod("FixtureMod", modFolder, sourceFolder))]);
        await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod");

        Assert.True(TestAdapters.Source().IsSourceMod(sourceFolder));

        var sourceText = SourceModTree.Document(sourceFolder, new PluginAddress("Fixture.esp", "FixtureMod"), door.FormKey.ToString()).Require().Body;
        Assert.Contains("The Big Door", sourceText);
    }

    [Fact]
    public async Task InitMod_LocalizedPluginMissingItsStringsFile_RefusesNamingTheMissingFile_SinceMutagenLookupOfAMissingFileDoesNotThrow()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-localized-missing-");
        using var gameDir = new ScratchDirectory("medit-initservice-localized-missing-game-");
        var (pluginPath, _) = WriteLocalizedPluginWhoseStringsMutagenWritesBesideIt(modFolder);

        var stringsFolderAsIfItNeverShippedWithTheDownload = Path.Combine(modFolder, "Strings");
        Directory.Delete(stringsFolderAsIfItNeverShippedWithTheDownload, recursive: true);

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDir, gameDir, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true)]);
        var result = (await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(InitRefusal.MissingLocalizationStrings, result.Refusal);

        const string stringsFileNamedByIsoLanguageCodeNotByLanguageName = "Fixture_en.STRINGS";
        Assert.Equal(
            $"Fixture.esp is a localized plugin but its strings file '{stringsFileNamedByIsoLanguageCodeNotByLanguageName}' was not found " +
            $"loose or in an archive, among the files the game loads or in {modFolder.Path}. Restore the file, then try again.",
            result.Message);
        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
    }

    [Fact]
    public async Task InitMod_ADeletedRecordStillHoldingFields_RefusesNamingIt_SinceMutagenWritesADeletedRecordAsItsHeader()
    {
        using var modFolder = new ScratchDirectory("medit-init-deleted-fields-");
        using var gameDir = new ScratchDirectory("medit-init-deleted-fields-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var npc = new FormKey(ModKey.FromFileName("Fixture.esp"), 0x800);
        DeletedNpcPlugin.WriteHoldingEveryField(pluginPath, npc);

        var loadOrder = SnapshotPlugins.Snapshot(gameDir, null, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", 0, Enabled: true, Winning: true)]);
        var result = (await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

        Assert.Equal((false, InitRefusal.RoundTripFailed), (result.Applied, result.Refusal));
        Assert.Equal(
            $"Fixture.esp does not round-trip through its own source: NPC_ {npc} is flagged Deleted " +
            "and still holds fields, which Mutagen does not write for a deleted record.",
            result.Message);
        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
    }

    [Fact]
    public async Task InitMod_ARecordWithANullFormId_RefusesNamingIt_SinceThePluginIsMalformed()
    {
        using var modFolder = new ScratchDirectory("medit-init-null-formid-");
        using var gameDir = new ScratchDirectory("medit-init-null-formid-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("NullGuy");
        mod.WriteToBinary(pluginPath);
        var bytes = File.ReadAllBytes(pluginPath);
        const int formIdOffset = 12;
        BitConverter.GetBytes(0u).CopyTo(bytes, bytes.AsSpan().LastIndexOf("NPC_"u8) + formIdOffset);
        File.WriteAllBytes(pluginPath, bytes);

        var loadOrder = SnapshotPlugins.Snapshot(gameDir, null, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", 0, Enabled: true, Winning: true)]);
        var result = (await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

        Assert.Equal((false, InitRefusal.RoundTripFailed), (result.Applied, result.Refusal));
        Assert.Equal(
            "Fixture.esp cannot become source: NPC_ 00000000 holds the null FormID, so the plugin is malformed.",
            result.Message);
        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
    }

    [Fact]
    public async Task InitMod_ARecordOfObjectIdZero_RefusesNamingIt_SinceItsFormKeyIsTheHeaders()
    {
        using var modFolder = new ScratchDirectory("medit-init-object-id-zero-");
        using var gameDir = new ScratchDirectory("medit-init-object-id-zero-game-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Master.esm") });
        mod.Npcs.AddNew("ZeroGuy");
        mod.WriteToBinary(pluginPath, new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
        {
            MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
        });
        var bytes = File.ReadAllBytes(pluginPath);
        const int formIdOffset = 12;
        const uint ownObjectIdZero = 0x01000000;
        BitConverter.GetBytes(ownObjectIdZero).CopyTo(bytes, bytes.AsSpan().LastIndexOf("NPC_"u8) + formIdOffset);
        File.WriteAllBytes(pluginPath, bytes);

        var loadOrder = SnapshotPlugins.Snapshot(gameDir, null, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", 0, Enabled: true, Winning: true)]);
        var result = (await InitEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

        Assert.Equal((false, InitRefusal.RoundTripFailed), (result.Applied, result.Refusal));
        Assert.Equal(
            "Fixture.esp cannot become source: NPC_ 000000:Fixture.esp holds object ID 000000, " +
            "the FormKey its plugin header's source holds.",
            result.Message);
        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
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
