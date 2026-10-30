using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.PluginAdapter.Repair;
using MEditService.RepositoriesLib;
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
        Assert.Single(TestEditService.DecompileAndCommitModHandler(_holder)
            .DecompileAndCommitAsync(ToDecompileAndCommit.In(_holder.Held?.Snapshot, SourceModName)).GetAwaiter().GetResult().Value().Applied);
    }

    public void Dispose() => _root.Dispose();

    [Fact]
    public async Task DecompileAndRepair_InASourceMod_CommitsTheMalformedRecordsFlagged_ThenTheRepairs_AndParksThePluginsBytes()
    {
        var fixture = Lossless;
        var plugin = AddToSourceMod(fixture.Malformed);
        var before = Head(_sourceMod);

        var result = await Repair(ToRepair(plugin));

        Assert.Equal([plugin], result.Applied);
        Assert.Equal(before, Git(_sourceMod, "rev-parse", "HEAD~2").Trim());
        Assert.Equal([$"Repair {Malformed}", $"Decompile {Malformed}, its malformed records flagged"], Subjects(_sourceMod, 2));
        Assert.True(TreeHolds(_sourceMod, "HEAD~1", fixture.Diagnosis), "the flagged commit holds no diagnosis");
        Assert.Contains(fixture.Change ?? "", Git(_sourceMod, "log", "-1", "--format=%B"), StringComparison.Ordinal);
        Assert.False(TreeHolds(_sourceMod, "HEAD", "\"Diagnoses\""), "the repair commit still holds a flagged record");
        Assert.Empty(Git(_sourceMod, "status", "--porcelain"));
        Assert.Empty(ExternalChanges.NamedBy(_holder.Current));
    }

    [Fact]
    public async Task DecompileAndRepair_InAModWithNoRepository_MakesOneHoldingItsOtherPluginsAndAssets_ThenCommitsTheRepair()
    {
        var plugin = AddToNewMod(Lossless.Malformed);
        WriteCleanPlugin(_newMod, "Clean.esp");
        File.WriteAllText(Path.Combine(Directory.CreateDirectory(Path.Combine(_newMod, "textures")).FullName, "a.dds"), "texture");
        Load(Entry(_sourceMod, "First.esp"), Entry(_newMod, Malformed), Entry(_newMod, "Clean.esp"));

        var result = await Repair(new PluginToRepair(plugin, MadeIn(_newMod, "textures/a.dds")));

        Assert.Equal([plugin], result.Applied);
        Assert.Equal([$"Repair {Malformed}", $"Init {NewModName}"], Subjects(_newMod, 3));
        var init = Git(_newMod, "show", "--name-only", "--format=", "HEAD~1");
        Assert.Contains("assets/textures/a.dds", init, StringComparison.Ordinal);
        Assert.Contains("plugin-source/Clean.esp/", init, StringComparison.Ordinal);
        Assert.True(TreeHolds(_newMod, "HEAD~1", "\"Diagnoses\""), "the init commit holds no flagged record");
        Assert.Equal(
            [$"plugin-source/{Malformed}"],
            Git(_newMod, "show", "--name-only", "--format=", "HEAD").Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(path => string.Join('/', path.Split('/').Take(2))).Distinct());
        Assert.Empty(Git(_newMod, "status", "--porcelain"));
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
            ["Repair Second Malformed.esp", "Decompile Second Malformed.esp, its malformed records flagged", $"Repair {Malformed}", $"Init {NewModName}"],
            Subjects(_newMod, 5));
    }

    [Fact]
    public async Task DecompileAndRepair_OfTwoPluginsOfAModWithNoRepository_TheSecondRefused_SaysTheNewRepositoryHoldsNoSourceForIt()
    {
        var first = AddToNewMod(Lossless.Malformed);
        var second = AddToNewMod(NoRepairFixture.Malformed with { FileName = "NoRepair.esp" });
        Load(Entry(_newMod, Malformed), Entry(_newMod, "NoRepair.esp"));

        var result = await Repair([ToRepair(first), ToRepair(second)]);

        Assert.Equal([first], result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((second, DecompileAndRepairRefusal.NoRepair), (refused.Item, refused.Refusal));
        Assert.EndsWith("The repository made for its mod holds no source for it.", refused.Message, StringComparison.Ordinal);
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
        var preview = ToRepair(plugin);
        var before = Head(_sourceMod);

        var refused = Assert.Single((await Repair([preview], adapter: new RepairWrittenWithAnUnplannedRecord(TestAdapters.Mutagen()))).Refused);

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

    private static NewRepository MadeIn(string folder, params string[] assets) => new(folder, assets, SourceInits.BuildFile);

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

    private static string Head(string mod) => Git(mod, "rev-parse", "HEAD").Trim();

    private static string[] Subjects(string mod, int count) => Git(mod, "log", $"-{count}", "--format=%s").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private static string Git(string mod, params string[] args) => GitProbe.Run(Path.Combine(mod, ".git"), mod, args);

    [Fact]
    public async Task DecompileAndRepair_OfAPluginChangedAfterItsDiagnoses_RepairsWhatTheFileNowHolds()
    {
        var plugin = AddToSourceMod(Lossless.Malformed);
        var adapter = new ChangingAfterItsDiagnoses(TestAdapters.Mutagen(), Path.Combine(_sourceMod, Malformed), Lossy.Malformed.Bytes.ToArray());

        var result = await Repair([ToRepair(plugin)], adapter: adapter);

        Assert.Equal([plugin], result.Applied);
    }

    [Fact]
    public async Task DecompileAndRepair_OfAPluginWithTwoMalformedRecords_RepairsBoth()
    {
        var plugin = AddToSourceMod(MalformationFixtures.ShortRegionBesideAWrongCountRace);

        var result = await Repair([ToRepair(plugin)]);

        Assert.Equal([plugin], result.Applied);
        Assert.Equal(2, Subjects(_sourceMod, 2).Length);
    }

    private sealed class ChangingAfterItsDiagnoses(IPluginAdapter inner, string path, byte[] changed) : DelegatingPluginAdapter(inner)
    {
        public override Answer<RepairPreviews, PluginFailure> RepairsOf(string pluginPath, GameRelease gameRelease)
        {
            var previews = base.RepairsOf(pluginPath, gameRelease);
            File.WriteAllBytes(path, changed);
            return previews;
        }
    }

    private sealed class RepairWrittenWithAnUnplannedRecord(IPluginAdapter inner) : DelegatingPluginAdapter(inner)
    {
        public override Answer<string, PluginFailure> WriteRepaired(
            string pluginPath, string destinationPath, GameRelease gameRelease)
        {
            var written = base.WriteRepaired(pluginPath, destinationPath, gameRelease);
            var mod = Fallout4Mod.CreateFromBinary(new ModPath(destinationPath), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("Unplanned");
            mod.WriteToBinary(destinationPath);
            return written;
        }
    }
}
