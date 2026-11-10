using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.PluginAdapter.Repair;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Source;

public sealed class DecompileAndRepairPluginHandlerTests : IDisposable
{
    private const string SourceModName = "SourceMod";
    private const string NewModName = "NewMod";
    private const string Malformed = "Malformed Records.esp";
    private readonly ScratchDirectory _root = new("medit-decompile-and-repair-");
    private readonly string _sourceMod;
    private readonly string _newMod;
    private readonly string _dataFolder;
    private readonly LoadOrderHolder _holder = new();

    public DecompileAndRepairPluginHandlerTests()
    {
        _sourceMod = Directory.CreateDirectory(Path.Combine(_root, "mods", SourceModName)).FullName;
        _newMod = Directory.CreateDirectory(Path.Combine(_root, "mods", NewModName)).FullName;
        _dataFolder = Directory.CreateDirectory(Path.Combine(_root, "Data")).FullName;
        WriteCleanPlugin(_sourceMod, "First.esp");
        Load(Entry(_sourceMod, "First.esp"));
        Assert.Single(TestEditService.VersionInGitHandler(_holder)
            .VersionInGitAsync(ToVersionInGit.In(_holder.Held?.Snapshot, SourceModName)).GetAwaiter().GetResult().Value().Applied);
    }

    public void Dispose() => _root.Dispose();

    [Fact]
    public async Task DecompileAndRepair_InASourceMod_CommitsThePluginAsItWas_ThenARepairOfOnlyItsPlaceholders_ThatCompiles()
    {
        var fixture = Lossless;
        var plugin = AddToSourceMod(fixture.Malformed);
        var before = Head(_sourceMod);

        var result = await Repair(ToRepair(plugin));

        Assert.Equal([plugin], result.Applied);
        Assert.Equal(before, Git(_sourceMod, "rev-parse", "HEAD~2").Trim());
        Assert.Equal([$"Repair {Malformed}", $"Decompile {Malformed} as it was, each malformed record a placeholder"], Subjects(_sourceMod, 2));
        Assert.True(TreeHolds(_sourceMod, "HEAD~1", fixture.Diagnosis), "no placeholder names the diagnosis");
        Assert.Contains(fixture.Change.Require(), Git(_sourceMod, "log", "-1", "--format=%B"), StringComparison.Ordinal);
        AssertTheRepairChangesOnlyThePlaceholders(_sourceMod);
        Assert.Empty(Git(_sourceMod, "status", "--porcelain"));
        Assert.Empty(ExternalChanges.NamedBy(_holder.Current));
        await AssertCompilesAsync(plugin);
    }

    [Fact]
    public async Task DecompileAndRepair_InAModWithNoRepository_MakesOneHoldingItsOtherPluginsAssetsAndThePluginAsItWas_ThenCommitsTheRepair()
    {
        var plugin = AddToNewMod(Lossless.Malformed);
        WriteCleanPlugin(_newMod, "Clean.esp");
        File.WriteAllText(Path.Combine(Directory.CreateDirectory(Path.Combine(_newMod, "textures")).FullName, "a.dds"), "texture");
        Load(Entry(_sourceMod, "First.esp"), Entry(_newMod, Malformed), Entry(_newMod, "Clean.esp"));

        var result = await Repair(new PluginToRepair(plugin, MadeIn(_newMod, "textures/a.dds")));

        Assert.Equal([plugin], result.Applied);
        Assert.Equal([$"Repair {Malformed}", $"Init {NewModName}"], Subjects(_newMod, 3));
        var init = Git(_newMod, "show", "--name-only", "--format=", "HEAD~1");
        Assert.Contains("textures/a.dds", init, StringComparison.Ordinal);
        Assert.Contains("plugin-source/Clean.esp/", init, StringComparison.Ordinal);
        Assert.True(TreeHolds(_newMod, "HEAD~1", Lossless.Diagnosis), "the init commit holds no placeholder");
        AssertTheRepairChangesOnlyThePlaceholders(_newMod);
        Assert.Empty(Git(_newMod, "status", "--porcelain"));
        Assert.Empty(ExternalChanges.NamedBy(_holder.Current));
        await AssertCompilesAsync(plugin);
    }

    [Fact]
    public async Task DecompileAndRepair_InAModWithNoRepository_AskedForTheInstanceRepository_CommitsItsSourceFolderAndItsModFoldersManifestThere_AndMakesNoRepositoryOfItsOwn()
    {
        var instanceRepository = Path.Combine(_root, ".git");
        GitProbe.Run(instanceRepository, _root, "init", "-q", "-b", "main");
        GitProbe.Run(instanceRepository, _root, "config", "user.name", "Test");
        GitProbe.Run(instanceRepository, _root, "config", "user.email", "test@localhost");
        var plugin = AddToNewMod(Lossless.Malformed);
        var sourceFolder = Path.Combine(_root, "source", NewModName);
        var linked = new RootFile($"{NewModName}.manifest.json", "the link"u8.ToArray());

        var result = await Repair(new PluginToRepair(plugin, MadeIn(sourceFolder, SourceModIn.InstanceRepository) with { ModFolderManifest = linked, ModFolderManifestInInit = true }));

        Assert.Equal([plugin], result.Applied);
        Assert.Equal([$"Repair {Malformed}", $"Init {NewModName}"], Subjects(_root, 3));
        Assert.Contains($"source/{NewModName}/plugin-source/{Malformed}/", Git(_root, "ls-tree", "-r", "--name-only", "HEAD"), StringComparison.Ordinal);
        Assert.Equal("the link", Git(_root, "show", $"HEAD~1:mods/{NewModName}/{linked.Name}"));
    }

    [Fact]
    public async Task DecompileAndRepair_OfTwoMalformedPluginsOfAModWithNoRepository_LandsBoth()
    {
        var first = AddToNewMod(Lossless.Malformed);
        var second = AddToNewMod(Lossless.Malformed with { FileName = "Second Malformed.esp" });
        Load(Entry(_newMod, Malformed), Entry(_newMod, "Second Malformed.esp"));

        var result = await Repair([ToRepair(first), ToRepair(second)]);

        Assert.Empty(result.Refused);
        Assert.Equal([first, second], result.Applied);
        Assert.Equal(
            ["Repair Second Malformed.esp", "Decompile Second Malformed.esp as it was, each malformed record a placeholder", $"Repair {Malformed}", $"Init {NewModName}"],
            Subjects(_newMod, 5));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task DecompileAndRepair_OfAMalformedAndAHealthyPluginOfAModWithNoRepository_GivesBothSource_WhicheverIsNamedFirst(bool healthyFirst)
    {
        var malformed = AddToNewMod(Lossless.Malformed);
        WriteCleanPlugin(_newMod, "Clean.esp");
        var clean = new PluginAddress("Clean.esp", NewModName);
        Load(Entry(_newMod, Malformed), Entry(_newMod, "Clean.esp"));
        var named = healthyFirst ? new[] { ToRepair(clean), ToRepair(malformed) } : [ToRepair(malformed), ToRepair(clean)];

        var result = await Repair(named);

        Assert.Equal([malformed], result.Applied);
        var healthy = Assert.Single(result.Refused);
        Assert.Equal(clean, healthy.Item);
        Assert.DoesNotContain("Decompile it instead", healthy.Message, StringComparison.Ordinal);
        var tree = Git(_newMod, "ls-tree", "-r", "--name-only", "HEAD");
        Assert.Contains($"plugin-source/{Malformed}/", tree, StringComparison.Ordinal);
        Assert.Contains("plugin-source/Clean.esp/", tree, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DecompileAndRepair_OfAMalformedPluginRefusedBeforeTheInit_SaysTheSourceFolderMadeHoldsNoSourceForIt()
    {
        var refusedFirst = AddToNewMod(NoRepairFixture.Malformed with { FileName = "NoRepair.esp" });
        var second = AddToNewMod(Lossless.Malformed);
        Load(Entry(_newMod, "NoRepair.esp"), Entry(_newMod, Malformed));

        var result = await Repair([ToRepair(refusedFirst), ToRepair(second)]);

        Assert.Equal([second], result.Applied);
        Assert.EndsWith("The source folder made for its mod holds no source for it.", Assert.Single(result.Refused).Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DecompileAndRepair_OfTwoPluginsOfAModWithNoRepository_TheSecondRefused_SaysTheSourceFolderMadeHoldsNoSourceForIt()
    {
        var first = AddToNewMod(Lossless.Malformed);
        var second = AddToNewMod(NoRepairFixture.Malformed with { FileName = "NoRepair.esp" });
        Load(Entry(_newMod, Malformed), Entry(_newMod, "NoRepair.esp"));

        var result = await Repair([ToRepair(first), ToRepair(second)]);

        Assert.Equal([first], result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((second, DecompileAndRepairRefusal.NoRepair), (refused.Item, refused.Refusal));
        Assert.EndsWith("The source folder made for its mod holds no source for it.", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DecompileAndRepair_ARepairThatDropsData_WritesWithoutForce_NamingTheChangeInItsCommit()
    {
        var plugin = AddToSourceMod(Lossy.Malformed);

        var result = await Repair(ToRepair(plugin));

        Assert.Equal([plugin], result.Applied);
        Assert.Contains(Lossy.Change.Require(), Git(_sourceMod, "log", "-1", "--format=%B"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task DecompileAndRepair_ADiagnosisNoRepairAnswers_IsRefusedNamingIt_AndWritesNothing()
    {
        var fixture = NoRepairFixture;
        var plugin = AddToSourceMod(fixture.Malformed);
        var before = Head(_sourceMod);

        var refused = Assert.Single((await Repair(ToRepair(plugin))).Refused);

        Assert.Equal(DecompileAndRepairRefusal.NoRepair, refused.Refusal);
        Assert.Contains(fixture.Diagnosis, refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, Head(_sourceMod));
    }

    [Fact]
    public async Task DecompileAndRepair_OfAPluginWhoseSourceHasWorkingTreeChanges_IsRefusedUnlessForced()
    {
        var plugin = AddToSourceMod(Lossless.Malformed);
        var stray = StrayFile();

        var refused = Assert.Single((await Repair(ToRepair(plugin))).Refused);
        var forced = await Repair([ToRepair(plugin)], force: true);

        Assert.Equal(DecompileAndRepairRefusal.WorkingTreeChanges, refused.Refusal);
        Assert.Contains("Stray.json", refused.Message, StringComparison.Ordinal);
        Assert.Equal([plugin], forced.Applied);
        Assert.False(File.Exists(stray));
    }

    [Fact]
    public async Task DecompileAndRepair_AWrittenRepairThatIsNotThePlannedOne_IsRefused_ThoughItRoundTrips_AndWritesNothing()
    {
        var plugin = AddToSourceMod(Lossless.Malformed);
        var before = Head(_sourceMod);

        var refused = Assert.Single((await Repair([ToRepair(plugin)], adapter: new RepairWrittenWithAnUnplannedRecord(TestAdapters.Mutagen()))).Refused);

        Assert.Equal(DecompileAndRepairRefusal.RoundTripFailed, refused.Refusal);
        Assert.Contains("records where the plugin holds", refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, Head(_sourceMod));
    }

    [Fact]
    public async Task DecompileAndRepair_InAModWithNoRepository_AndNoSourceFolderNamed_IsRefused()
    {
        var plugin = AddToNewMod(Lossless.Malformed);
        Load(Entry(_newMod, Malformed) with { NamedProvider = new PluginProvider.FromMod(NewModName, _newMod, null) });

        var refused = Assert.Single((await Repair(new PluginToRepair(plugin))).Refused);

        Assert.Equal(DecompileAndRepairRefusal.NoSourceFolder, refused.Refusal);
        Assert.False(Directory.Exists(Path.Combine(_newMod, ".git")));
    }

    private static MalformationFixture Lossless => MalformationFixtures.ShortRegion;

    private static MalformationFixture NoRepairFixture => MalformationFixtures.All.Single(f => f.Malformation == "EntryPointParameterOfAnotherType");

    private static MalformationFixture Lossy => MalformationFixtures.All.Single(f => f.Malformation == "EntryPointParametersOnAParameterlessFunction");

    private PluginAddress AddToSourceMod(GeneratedPlugin plugin)
    {
        plugin.WriteInto(_sourceMod);
        Load(Entry(_sourceMod, "First.esp"), Entry(_sourceMod, plugin.FileName));
        return new PluginAddress(plugin.FileName, SourceModName);
    }

    private PluginAddress AddToNewMod(GeneratedPlugin plugin)
    {
        plugin.WriteInto(_newMod);
        Load(Entry(_newMod, plugin.FileName));
        return new PluginAddress(plugin.FileName, NewModName);
    }

    private void Load(params LoadOrderEntry[] entries) =>
        _holder.Apply(SnapshotPlugins.Snapshot(_dataFolder, _root, GameRelease.Fallout4, entries.Select((entry, at) => entry with { Line = at })));

    private static LoadOrderEntry Entry(string modFolder, string plugin) =>
        new(plugin, Path.Combine(modFolder, plugin), Path.GetFileName(modFolder), 0, Enabled: true, Winning: true);

    private PluginToRepair ToRepair(PluginAddress plugin) => new(plugin, MadeIn(_newMod));

    private static SourceFolderContents MadeIn(string folder, params string[] assets) => MadeIn(folder, SourceModIn.NewRepository, assets);

    private static SourceFolderContents MadeIn(string folder, SourceModIn heldIn, params string[] assets) => new(folder, heldIn, assets, SourceInits.BuildFile);

    private string StrayFile()
    {
        var stray = Path.Combine(Directory.CreateDirectory(Path.Combine(_sourceMod, "plugin-source", Malformed)).FullName, "Stray.json");
        File.WriteAllText(stray, "{}");
        return stray;
    }

    private Task<DecompileAndRepairResult> Repair(PluginToRepair plugin) => Repair([plugin]);

    private async Task<DecompileAndRepairResult> Repair(IReadOnlyList<PluginToRepair> plugins, bool force = false, IPluginAdapter? adapter = null) =>
        (await TestEditService.Over(_holder, adapter: adapter).GetRequiredService<DecompileAndRepairPluginHandler>()
            .DecompileAndRepairAsync(plugins, force)).Value();

    private static void WriteCleanPlugin(string modFolder, string name)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(Path.GetFileNameWithoutExtension(name) + "Npc");
        mod.WriteToBinary(Path.Combine(modFolder, name));
    }

    private static bool TreeHolds(string mod, string revision, string text) =>
        GitProbe.TryRun(Path.Combine(mod, ".git"), mod, out _, "grep", "-q", "-F", text, revision, "--", "plugin-source");

    private static void AssertTheRepairChangesOnlyThePlaceholders(string mod)
    {
        var placeholders = Git(mod, "grep", "-l", "-F", "\"Malformed\": [", "HEAD~1", "--", "plugin-source")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(found => found["HEAD~1:".Length..]);
        Assert.NotEmpty(placeholders);
        Assert.Equal(placeholders, Git(mod, "diff", "--name-only", "HEAD~1", "HEAD").Split('\n', StringSplitOptions.RemoveEmptyEntries));
    }

    private async Task AssertCompilesAsync(PluginAddress plugin)
    {
        var applied = Assert.Single((await TestEditService.CompileHandler(_holder).CompileAsync([plugin])).Value().Applied);
        Assert.Equal(plugin, new PluginAddress(applied.Name, applied.Origin));
    }

    private static string Head(string mod) => Git(mod, "rev-parse", "HEAD").Trim();

    private static string[] Subjects(string mod, int count) => Git(mod, "log", $"-{count}", "--format=%s").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private static string Git(string mod, params string[] args) => GitProbe.Run(Path.Combine(mod, ".git"), mod, args);

    [Fact]
    public async Task DecompileAndRepair_OfAPluginChangedAfterItsDiagnoses_RepairsWhatTheFileNowHolds_AndNamesThatInItsCommits()
    {
        var plugin = AddToSourceMod(Lossless.Malformed);
        var adapter = new ChangingAfterItsDiagnoses(TestAdapters.Mutagen(), Path.Combine(_sourceMod, Malformed), Lossy.Malformed.Bytes.ToArray());

        var result = await Repair([ToRepair(plugin)], adapter: adapter);

        Assert.Equal([plugin], result.Applied);
        var messages = Git(_sourceMod, "log", "-2", "--format=%B");
        Assert.Contains(Lossy.Change.Require(), messages, StringComparison.Ordinal);
        Assert.Contains(Lossy.Diagnosis, messages, StringComparison.Ordinal);
        Assert.DoesNotContain(Lossless.Change.Require(), messages, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DecompileAndRepair_OfAPluginWithTwoMalformedRecords_RepairsBoth_AndNamesBothInItsCommits()
    {
        var plugin = AddToSourceMod(MalformationFixtures.ShortRegionBesideAWrongCountRace);

        var result = await Repair([ToRepair(plugin)]);

        Assert.Equal([plugin], result.Applied);
        var messages = Git(_sourceMod, "log", "-2", "--format=%B");
        Assert.Contains("HarborRegion", messages, StringComparison.Ordinal);
        Assert.Contains("HarborRace", messages, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DecompileAndRepair_OfAPluginWithTwoDiagnosesNoRepairAnswers_IsRefusedNamingBoth_AndWritesNothing()
    {
        var plugin = AddToSourceMod(MalformationFixtures.ShortRegionBesideTwoUnansweredPerks);
        var before = Head(_sourceMod);

        var refused = Assert.Single((await Repair([ToRepair(plugin)])).Refused);

        Assert.Equal(DecompileAndRepairRefusal.NoRepair, refused.Refusal);
        Assert.Contains("HarborPerkOne", refused.Message, StringComparison.Ordinal);
        Assert.Contains("HarborPerkTwo", refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, Head(_sourceMod));
    }

    [Fact]
    public async Task DecompileAndRepair_OfAPluginThatIsNotMalformed_IsRefusedNamingDecompile()
    {
        var clean = new PluginAddress("First.esp", SourceModName);

        var refused = Assert.Single((await Repair([ToRepair(clean)])).Refused);

        Assert.Equal(DecompileAndRepairRefusal.NotMalformed, refused.Refusal);
        Assert.Contains("Decompile it", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DecompileAndRepair_WhoseRepairedPluginStillFailsToRead_RefusesWithoutOfferingItself()
    {
        var plugin = AddToSourceMod(Lossless.Malformed);

        var refused = Assert.Single((await Repair([ToRepair(plugin)], adapter: new LeavingTheRepairUnmade(TestAdapters.Mutagen()))).Refused);

        Assert.Equal(DecompileAndRepairRefusal.RoundTripFailed, refused.Refusal);
        Assert.DoesNotContain("Decompile and repair", refused.Message, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class ChangingAfterItsDiagnoses(IPluginAdapter inner, string path, byte[] changed) : DelegatingPluginAdapter(inner)
    {
        public override Answer<IReadOnlyList<RepairPreview>, PluginFailure> RepairsOf(string pluginPath, GameRelease gameRelease)
        {
            var diagnosed = base.RepairsOf(pluginPath, gameRelease);
            File.WriteAllBytes(path, changed);
            return diagnosed;
        }
    }

    private sealed class LeavingTheRepairUnmade(IPluginAdapter inner) : DelegatingPluginAdapter(inner)
    {
        public override Answer<RepairedPlugin, PluginFailure> WriteRepaired(string pluginPath, string destinationPath, GameRelease gameRelease)
        {
            var written = base.WriteRepaired(pluginPath, destinationPath, gameRelease);
            File.Copy(pluginPath, destinationPath, overwrite: true);
            return written;
        }

        public override Answer<RepairedPlugin, PluginFailure> VerifyRepaired(RepairedPlugin written, GameRelease gameRelease) => written;
    }

    private sealed class RepairWrittenWithAnUnplannedRecord(IPluginAdapter inner) : DelegatingPluginAdapter(inner)
    {
        public override Answer<RepairedPlugin, PluginFailure> WriteRepaired(string pluginPath, string destinationPath, GameRelease gameRelease)
        {
            var written = base.WriteRepaired(pluginPath, destinationPath, gameRelease);
            var mod = Fallout4Mod.CreateFromBinary(new ModPath(destinationPath), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("Unplanned");
            mod.WriteToBinary(destinationPath);
            return written;
        }
    }
}
