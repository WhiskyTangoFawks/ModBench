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

public sealed class DecompileAndCommitModTests
{
    [Fact]
    public async Task InitMod_RefusesTheWholeMod_WhenOnePluginCannotBeRead_WritingNothing()
    {
        using var modFolder = new ScratchDirectory("medit-init-unopened-");
        using var dataFolder = new ScratchDirectory("medit-init-unopened-data-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("FirstNpc");
        mod.WriteToBinary(pluginPath);

        var existingFileTheAdapterCannotRead = Path.Combine(modFolder, "Locked.esp");
        new Fallout4Mod(ModKey.FromFileName("Locked.esp"), Fallout4Release.Fallout4).WriteToBinary(existingFileTheAdapterCannotRead);

        var loadOrder = SnapshotPlugins.Snapshot(dataFolder, null, GameRelease.Fallout4,
        [
            new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Locked.esp", existingFileTheAdapterCannotRead, "FixtureMod", 1, Enabled: true, Winning: true),
        ]);

        var result = (await DecompileAndCommitEveryPluginOf.ModAsync(loadOrder, "FixtureMod", new LockedPluginAdapter("Locked.esp"))).Value();

        Assert.Empty(result.Applied);
        var refusal = Assert.Single(result.Refused);
        Assert.Equal(("FixtureMod", DecompileAndCommitRefusal.RoundTripFailed), (refusal.Item, refusal.Refusal));
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
    public async Task InitMod_OfAModThatProvidesAPlugin_MakesItASourceModHoldingEachRecord()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-");
        using var dataFolder = new ScratchDirectory("medit-initservice-data-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc1 = mod.Npcs.AddNew("FirstNpc");
        var npc2 = mod.Npcs.AddNew("SecondNpc");
        mod.WriteToBinary(pluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            dataFolder, dataFolder, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true)]);
        await DecompileAndCommitEveryPluginOf.ModAsync(loadOrder, "FixtureMod");

        Assert.True(TestAdapters.Source().IsSourceMod(modFolder));

        var plugin = new PluginAddress("Fixture.esp", "FixtureMod");
        var first = SourceModTree.Document(modFolder, plugin, npc1.FormKey.ToString()).Require();
        var second = SourceModTree.Document(modFolder, plugin, npc2.FormKey.ToString()).Require();
        Assert.Equal("FirstNpc", first.EditorId);
        Assert.Equal("SecondNpc", second.EditorId);
    }

    [Fact]
    public async Task InitMod_OfAPluginInAModWithARepository_RefusesBeforeParsingIt()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-alreadysource-");
        using var dataFolder = new ScratchDirectory("medit-initservice-alreadysource-data-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("SomeNpc");
        CompiledPluginTemplates.WriteCompiledPlugin(modFolder, mod);

        var loadOrder = SnapshotPlugins.Snapshot(
            dataFolder, dataFolder, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true)]);

        byte[] notAPluginSoAnyDeepParseFails = [0x00, 0x01, 0x02, 0x03];
        File.WriteAllBytes(pluginPath, notAPluginSoAnyDeepParseFails);
        var result = (await DecompileAndCommitEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(DecompileAndCommitRefusal.AlreadyInitialized, result.Refusal);
    }

    [Fact]
    public async Task InitMod_OfAMod_TakesOnlyThePluginsItProvides_NotAnotherModsPluginOfTheSameFileName()
    {
        using var modA = new ScratchDirectory("medit-initservice-twomods-a-");
        using var modB = new ScratchDirectory("medit-initservice-twomods-b-");
        using var dataFolder = new ScratchDirectory("medit-initservice-twomods-data-");
        var pathA = Path.Combine(modA, "Same.esp");
        var pathB = Path.Combine(modB, "Same.esp");
        foreach (var path in new[] { pathA, pathB })
        {
            var mod = new Fallout4Mod(ModKey.FromFileName("Same.esp"), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SomeNpc");
            mod.WriteToBinary(path);
        }

        var loadOrder = SnapshotPlugins.Snapshot(dataFolder, null, GameRelease.Fallout4,
        [
            new LoadOrderEntry("Same.esp", pathA, "ModA", Line: 0, Enabled: true, Winning: false),
            new LoadOrderEntry("Same.esp", pathB, "ModB", Line: 1, Enabled: true, Winning: true),
        ]);

        var result = (await DecompileAndCommitEveryPluginOf.ModAsync(loadOrder, "ModA")).Value();

        Assert.Equal([new PluginAddress("Same.esp", "ModA")], Assert.Single(result.Applied).Plugins);
        Assert.True(TestAdapters.Source().IsSourceMod(modA));
        Assert.False(TestAdapters.Source().IsSourceMod(modB));
    }

    [Fact]
    public async Task InitMod_OverTwoPluginsOfOneOrigin_ProgressNamesTheModAndEachPhase_AndEndsAtRest()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-progress-");
        using var dataFolder = new ScratchDirectory("medit-initservice-progress-data-");
        var firstPluginPath = Path.Combine(modFolder, "First.esp");
        var firstMod = new Fallout4Mod(ModKey.FromFileName("First.esp"), Fallout4Release.Fallout4);
        firstMod.Npcs.AddNew("OnlyNpc");
        firstMod.WriteToBinary(firstPluginPath);

        var secondPluginPath = Path.Combine(modFolder, "Second.esp");
        var secondMod = new Fallout4Mod(ModKey.FromFileName("Second.esp"), Fallout4Release.Fallout4);
        for (var i = 0; i < 400; i++) secondMod.Npcs.AddNew($"Npc{i}");
        secondMod.WriteToBinary(secondPluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(
            dataFolder, dataFolder, GameRelease.Fallout4,
            [
                new LoadOrderEntry("First.esp", firstPluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true),
                new LoadOrderEntry("Second.esp", secondPluginPath, "FixtureMod", Line: 1, Enabled: true, Winning: true),
            ]);

        var notifications = new InMemoryNotificationPublisher();
        await DecompileAndCommitEveryPluginOf.ModAsync(loadOrder, "FixtureMod", notifications: notifications);

        var observed = notifications.Notifications.OfType<DecompileAndCommitProgressNotification>().ToList();
        Assert.Equal(
            [DecompileAndCommitPhase.Parsing, DecompileAndCommitPhase.Serializing, DecompileAndCommitPhase.Parsing, DecompileAndCommitPhase.Serializing,
             DecompileAndCommitPhase.Committing],
            observed.Select(n => n.Phase).OfType<DecompileAndCommitPhase>());
        Assert.All(observed.Where(n => n.Phase is not null), n => Assert.Equal("FixtureMod", n.Progress.Mod));
        Assert.Equal(new ModlistProgress(null, 0, 0), observed[^1].Progress);
    }

    [Fact]
    public async Task InitMod_LocalizedPluginWithABsaBesideIt_MaterializesTheRealStringInTheNamedSourceFolder()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-localized-");
        using var sourceFolder = new ScratchDirectory("medit-initservice-localized-source-");
        using var dataFolder = new ScratchDirectory("medit-initservice-localized-data-");
        var (pluginPath, door) = WriteLocalizedPluginWhoseStringsMutagenWritesBesideIt(modFolder);
        File.WriteAllBytes(Path.Combine(modFolder, "UnrelatedMod - Main.ba2"), []);

        var loadOrder = SnapshotPlugins.Snapshot(
            dataFolder, dataFolder, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true,
                NamedProvider: new PluginProvider.FromMod("FixtureMod", modFolder, sourceFolder))]);
        await DecompileAndCommitEveryPluginOf.ModAsync(loadOrder, "FixtureMod");

        Assert.True(TestAdapters.Source().IsSourceMod(sourceFolder));
        var sourceText = SourceModTree.Document(sourceFolder, new PluginAddress("Fixture.esp", "FixtureMod"), door.FormKey.ToString()).Require().Body;
        Assert.Contains("The Big Door", sourceText);
    }

    [Fact]
    public async Task InitMod_LocalizedPluginMissingItsStringsFile_RefusesNamingTheMissingFile_SinceMutagenLookupOfAMissingFileDoesNotThrow()
    {
        using var modFolder = new ScratchDirectory("medit-initservice-localized-missing-");
        using var dataFolder = new ScratchDirectory("medit-initservice-localized-missing-data-");
        var (pluginPath, _) = WriteLocalizedPluginWhoseStringsMutagenWritesBesideIt(modFolder);

        var stringsFolderAsIfItNeverShippedWithTheDownload = Path.Combine(modFolder, "Strings");
        Directory.Delete(stringsFolderAsIfItNeverShippedWithTheDownload, recursive: true);

        var loadOrder = SnapshotPlugins.Snapshot(
            dataFolder, dataFolder, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", Line: 0, Enabled: true, Winning: true)]);
        var result = (await DecompileAndCommitEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

        Assert.False(result.Applied);
        Assert.Equal(DecompileAndCommitRefusal.MissingLocalizationStrings, result.Refusal);

        const string stringsFileNamedByIsoLanguageCodeNotByLanguageName = "Fixture_en.STRINGS";
        Assert.Equal(
            $"Fixture.esp is a localized plugin but its strings file '{stringsFileNamedByIsoLanguageCodeNotByLanguageName}' was not found " +
            $"loose or in an archive, among the files the game loads or in {modFolder.Path}. Restore the file, then try again.",
            result.Message);
        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
    }

    public static TheoryData<string, Action<string>, string> PluginsTheGateRefusesNamingARecord => new()
    {
        {
            "deleted record holding fields",
            path => DeletedNpcPlugin.WriteHoldingEveryField(path, new FormKey(ModKey.FromFileName("Fixture.esp"), 0x800)),
            "Fixture.esp does not round-trip through its own source: NPC_ 000800:Fixture.esp is flagged Deleted " +
            "and still holds fields, which Mutagen does not write for a deleted record."
        },
        {
            "record absent from the rewrite",
            path => UnknownGroupPlugin.Write(path, new FormKey(ModKey.FromFileName("Fixture.esp"), 0x800), new FormKey(ModKey.FromFileName("Fixture.esp"), 0x801)),
            "Fixture.esp does not round-trip through its own source: MISC 000801:Fixture.esp is absent from the rewrite, " +
            "so its records cannot be proven intact."
        },
        {
            "null FormID", WriteNpcWithTheNullFormId,
            "Fixture.esp cannot become source: NPC_ 00000000 holds the null FormID, so the plugin is malformed."
        },
    };

    [Theory]
    [MemberData(nameof(PluginsTheGateRefusesNamingARecord))]
    public async Task InitMod_OfAPluginTheGateRefusesNamingARecord_RefusesTheModWithThatCause_CommittingNothing(string _, Action<string> writePlugin, string message)
    {
        using var modFolder = new ScratchDirectory("medit-init-gate-refusal-");
        using var dataFolder = new ScratchDirectory("medit-init-gate-refusal-data-");
        var pluginPath = Path.Combine(modFolder, "Fixture.esp");
        writePlugin(pluginPath);

        var loadOrder = SnapshotPlugins.Snapshot(dataFolder, null, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, "FixtureMod", 0, Enabled: true, Winning: true)]);
        var result = (await DecompileAndCommitEveryPluginOf.ModAsync(loadOrder, "FixtureMod")).Only();

        Assert.Equal((false, DecompileAndCommitRefusal.RoundTripFailed), (result.Applied, result.Refusal));
        Assert.Equal(message, result.Message);
        Assert.False(TestAdapters.Source().IsSourceMod(modFolder));
    }

    private static void WriteNpcWithTheNullFormId(string pluginPath)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("Npc");
        mod.WriteToBinary(pluginPath);
        var bytes = File.ReadAllBytes(pluginPath);
        const int formIdOffset = 12;
        BitConverter.GetBytes(0u).CopyTo(bytes, bytes.AsSpan().LastIndexOf("NPC_"u8) + formIdOffset);
        File.WriteAllBytes(pluginPath, bytes);
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
