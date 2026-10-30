using MEditService.Codec.Serialization;
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

        var result = await Repair(await Previewed(plugin));

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

        var result = await Repair(await Previewed(plugin, MadeIn(_newMod, "textures/a.dds")));

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

        var result = await Repair([.. (await PreviewAll(first, second)).Applied.Select(p => new PluginToRepair(p.Plugin, p.Hash, MadeIn(_newMod)))]);

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
        var second = AddToNewMod(Lossy.Malformed with { FileName = "Lossy.esp" });
        Load(Entry(_newMod, Malformed), Entry(_newMod, "Lossy.esp"));

        var result = await Repair([.. (await PreviewAll(first, second)).Applied.Select(p => new PluginToRepair(p.Plugin, p.Hash, MadeIn(_newMod)))]);

        Assert.Equal([first], result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((second, DecompileAndRepairRefusal.DropsData), (refused.Item, refused.Refusal));
        Assert.EndsWith("The repository made for its mod holds no source for it.", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DecompileAndRepair_ARepairThatDropsData_IsRefusedNamingTheChange_AndWritesNothing()
    {
        var plugin = AddToSourceMod(Lossy.Malformed);
        var before = Head(_sourceMod);

        var refused = Assert.Single((await Repair(await Previewed(plugin))).Refused);

        Assert.Equal(DecompileAndRepairRefusal.DropsData, refused.Refusal);
        Assert.Contains(Lossy.Change.Require(), refused.Message, StringComparison.Ordinal);
        Assert.Contains("force", refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, Head(_sourceMod));
    }

    [Fact]
    public async Task DecompileAndRepair_ARepairThatDropsData_WritesWhenForced()
    {
        var plugin = AddToSourceMod(Lossy.Malformed);

        var forced = await Repair([await Previewed(plugin)], force: true);

        Assert.Equal([plugin], forced.Applied);
        Assert.Equal($"Repair {Malformed}", Subjects(_sourceMod, 1).Single());
    }

    [Fact]
    public async Task DecompileAndRepair_ARepairThatDropsDataOverWorkingTreeChanges_IsRefusedOnceListingBoth_AndForceWaivesBoth()
    {
        var plugin = AddToSourceMod(Lossy.Malformed);
        var stray = StrayFile();

        var refused = Assert.Single((await Repair([await Previewed(plugin)])).Refused);
        var forced = await Repair([await Previewed(plugin)], force: true);

        Assert.Equal(DecompileAndRepairRefusal.DropsData, refused.Refusal);
        Assert.Contains(Lossy.Change.Require(), refused.Message, StringComparison.Ordinal);
        Assert.Contains("Stray.json", refused.Message, StringComparison.Ordinal);
        Assert.Equal([plugin], forced.Applied);
        Assert.False(File.Exists(stray));
    }

    [Fact]
    public async Task DecompileAndRepair_AgreedDrops_WaiveTheDroppedDataAlone()
    {
        var plugin = AddToSourceMod(Lossy.Malformed);
        StrayFile();

        var dirty = Assert.Single((await Repair([await Previewed(plugin)], agreedDrops: true)).Refused);
        File.Delete(StrayFile());
        var clean = await Repair([await Previewed(plugin)], agreedDrops: true);

        Assert.Equal(DecompileAndRepairRefusal.WorkingTreeChanges, dirty.Refusal);
        Assert.Equal([plugin], clean.Applied);
    }

    [Fact]
    public async Task DecompileAndRepair_ADiagnosisNoRepairAnswers_IsRefusedNamingIt_AndWritesNothing()
    {
        var fixture = MalformationFixtures.All.Single(f => f.Malformation == "EntryPointParameterOfAnotherType");
        var plugin = AddToSourceMod(fixture.Malformed);
        var before = Head(_sourceMod);

        var refused = Assert.Single((await Repair(await Previewed(plugin))).Refused);

        Assert.Equal(DecompileAndRepairRefusal.NoRepair, refused.Refusal);
        Assert.Contains(fixture.Diagnosis, refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, Head(_sourceMod));
    }

    [Fact]
    public async Task DecompileAndRepair_OfAPluginWhoseBytesChangedSinceThePreview_IsRefused_AndWritesNothing()
    {
        var plugin = AddToSourceMod(Lossless.Malformed);
        var preview = await Previewed(plugin);
        var changed = Lossless.Malformed.Bytes.ToArray();
        changed[^1] ^= 1;
        File.WriteAllBytes(Path.Combine(_sourceMod, Malformed), changed);
        var before = Head(_sourceMod);

        var refused = Assert.Single((await Repair(preview)).Refused);

        Assert.Equal(DecompileAndRepairRefusal.ChangedSincePreview, refused.Refusal);
        Assert.Contains($"{Malformed}'s bytes changed since the repair preview", refused.Message, StringComparison.Ordinal);
        Assert.Contains(Lossless.Change ?? "", refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, Head(_sourceMod));
    }

    [Fact]
    public async Task DecompileAndRepair_OfAPluginWhoseSourceHasWorkingTreeChanges_IsRefusedUnlessForced()
    {
        var plugin = AddToSourceMod(Lossless.Malformed);
        var stray = StrayFile();

        var refused = Assert.Single((await Repair(await Previewed(plugin))).Refused);
        var forced = await Repair([await Previewed(plugin)], force: true);

        Assert.Equal(DecompileAndRepairRefusal.WorkingTreeChanges, refused.Refusal);
        Assert.Contains("Stray.json", refused.Message, StringComparison.Ordinal);
        Assert.Equal([plugin], forced.Applied);
        Assert.False(File.Exists(stray));
    }

    [Fact]
    public async Task DecompileAndRepair_AWrittenRepairThatIsNotThePlannedOne_IsRefused_ThoughItRoundTrips_AndWritesNothing()
    {
        var plugin = AddToSourceMod(Lossless.Malformed);
        var preview = await Previewed(plugin);
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

        var refused = Assert.Single((await Repair(await Previewed(plugin, made: null))).Refused);

        Assert.Equal(DecompileAndRepairRefusal.NoSourceFolder, refused.Refusal);
        Assert.False(Directory.Exists(Path.Combine(_newMod, ".git")));
    }

    [Fact]
    public async Task Preview_OfAMalformedPlugin_NamesEachDiagnosisAndItsChange_AndOfACleanOneRefusesItNamingDecompile()
    {
        var plugin = AddToSourceMod(Lossless.Malformed);

        var previews = await PreviewAll(plugin, new PluginAddress("First.esp", SourceModName));

        var diagnosis = Assert.Single(Assert.Single(previews.Applied).Diagnoses);
        Assert.Equal((Lossless.Diagnosis, Lossless.Change), (diagnosis.Diagnosis.Describe(), diagnosis.Change?.Description));
        var refused = Assert.Single(previews.Refused);
        Assert.Equal(DecompileAndRepairRefusal.NotMalformed, refused.Refusal);
        Assert.Contains("Decompile it", refused.Message, StringComparison.Ordinal);
    }

    private static MalformationFixture Lossless => MalformationFixtures.ShortRegion;

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

    private async Task<RepairPreviewsResult> PreviewAll(params PluginAddress[] plugins) =>
        (await TestEditService.Over(_holder).GetRequiredService<RepairPreviewsHandler>().PreviewAsync(plugins)).Value();

    private Task<PluginToRepair> Previewed(PluginAddress plugin) => Previewed(plugin, MadeIn(_newMod));

    private async Task<PluginToRepair> Previewed(PluginAddress plugin, NewRepository? made)
    {
        var preview = Assert.Single((await PreviewAll(plugin)).Applied);
        return new PluginToRepair(preview.Plugin, preview.Hash, made);
    }

    private static NewRepository MadeIn(string folder, params string[] assets) => new(folder, assets, SourceInits.ManifestOf(NewModName));

    private string StrayFile()
    {
        var stray = Path.Combine(Directory.CreateDirectory(Path.Combine(_sourceMod, "plugin-source", Malformed)).FullName, "Stray.json");
        File.WriteAllText(stray, "{}");
        return stray;
    }

    private Task<DecompileAndRepairResult> Repair(PluginToRepair plugin) => Repair([plugin]);

    private async Task<DecompileAndRepairResult> Repair(IReadOnlyList<PluginToRepair> plugins, bool force = false, IPluginAdapter? adapter = null, bool agreedDrops = false) =>
        (await TestEditService.Over(_holder, adapter: adapter).GetRequiredService<DecompileAndRepairPluginHandler>()
            .DecompileAndRepairAsync(plugins, force, agreedDrops)).Value();

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
    public async Task DecompileAndRepair_WhoseRepairedPluginStillFailsAtAnUnchosenRecord_RefusesWithoutNamingItself()
    {
        var plugin = AddToSourceMod(MalformationFixtures.ShortRegionBesideAWrongCountRace);
        var previewed = await Previewed(plugin);

        var refused = Assert.Single((await Repair([previewed], adapter: new PreviewingOnlyTheRegion(TestAdapters.Mutagen()))).Refused);

        Assert.Equal(DecompileAndRepairRefusal.RoundTripFailed, refused.Refusal);
        Assert.Contains("HarborRace", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Decompile and repair", refused.Message, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class PreviewingOnlyTheRegion(IPluginAdapter inner) : DelegatingPluginAdapter(inner)
    {
        public override Answer<RepairPreviews, PluginFailure> RepairsOf(string pluginPath, GameRelease gameRelease)
        {
            var previews = base.RepairsOf(pluginPath, gameRelease).Answered();
            return previews with { Diagnoses = [.. previews.Diagnoses.Where(preview => preview.Diagnosis.Anchor?.StartsWith("REGN", StringComparison.Ordinal) == true)] };
        }
    }

    private sealed class RepairWrittenWithAnUnplannedRecord(IPluginAdapter inner) : DelegatingPluginAdapter(inner)
    {
        public override Answer<string, PluginFailure> WriteRepaired(
            string pluginPath, string previewedHash, IReadOnlyCollection<PluginDiagnosis> chosen, string destinationPath, GameRelease gameRelease)
        {
            var written = base.WriteRepaired(pluginPath, previewedHash, chosen, destinationPath, gameRelease);
            var mod = Fallout4Mod.CreateFromBinary(new ModPath(destinationPath), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("Unplanned");
            mod.WriteToBinary(destinationPath);
            return written;
        }
    }
}
